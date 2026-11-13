// Fiche AMI d'un établissement (étapes 1 à 10) : saisie par le comité de pilotage (tous les
// champs) et par le médecin chef de l'établissement (champs facultatifs, config/ficheEtablissement.js),
// calculs (cibles, capacités, ressources humaines, complétude) et circuit de validation.
const mongoose = require('mongoose');
const QRCode = require('qrcode');
const Etablissement = require('../models/Etablissement');
const EntiteGeographique = require('../models/EntiteGeographique');
const CoefficientDemographique = require('../models/CoefficientDemographique');
const Accouchement = require('../models/Accouchement');
const Consultation = require('../models/Consultation');
const Reco = require('../models/Reco');
const { envoyerFichier, supprimerFichier, urlSignee } = require('../config/r2');
const { messageValidation } = require('../config/erreursFr');
const R = require('../config/ficheEtablissement');
const V = require('../config/ficheSpecifique');

const ROLE_CHEF = 'Médecin chef de service';
const DOSSIER_PIECES = 'etablissement-pieces';

const erreur = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const estObjet = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Auteur d'une action : membre du comité ou soignant connecté. */
function acteur(req) {
  if (req.membreComite) return { type: 'comite', id: String(req.membreComite._id), nom: `${req.membreComite.prenom} ${req.membreComite.nom}` };
  return { type: 'soignant', id: String(req.soignant._id), nom: `${req.soignant.prenom} ${req.soignant.nom}` };
}

/** Chaînes vides du formulaire → null (listes de choix, nombres et dates facultatifs). */
function nettoyer(v) {
  if (v === '') return null;
  if (Array.isArray(v)) return v.map(nettoyer);
  if (estObjet(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, nettoyer(x)]));
  return v;
}

/** Ouvre la fiche d'un établissement qui n'en a pas encore. */
function initialiserFiche(e, auteur, { creation = false } = {}) {
  if (e.fiche) return;
  e.fiche = {
    circuit: {
      statut: 'Brouillon',
      anterieur: !creation,
      historique: [{ de: null, vers: 'Brouillon', action: creation ? 'Création de la fiche' : 'Ouverture de la fiche', par: auteur, le: new Date() }],
    },
  };
}

const memePersonne = (a = {}, b = {}) => ['nom', 'postnom', 'prenom', 'fonction', 'telephone']
  .every((k) => String(a[k] ?? '').trim() === String(b[k] ?? '').trim());

/**
 * Recopie les sections reçues dans la fiche. `role` : 'comite' (tout) ou 'chef' (champs
 * facultatifs seulement : un champ réservé au comité est refusé, pas ignoré en silence).
 * Retourne la liste des sections modifiées.
 */
function appliquerFiche(e, brut, auteur, role) {
  if (!estObjet(brut)) throw erreur(400, 'Fiche invalide.');
  const d = nettoyer(brut);
  const f = e.fiche;
  const sections = [];

  for (const section of Object.keys(d)) {
    if (!R.SECTIONS.includes(section)) throw erreur(400, `Section inconnue : ${section}.`);
    const droit = role === 'comite' ? true : R.CHAMPS_CHEF[section];
    if (!droit) throw erreur(403, `La section « ${section} » est saisie par le comité de pilotage.`);
    const valeur = d[section];

    if (R.SECTIONS_LISTE.includes(section)) {
      if (!Array.isArray(valeur)) throw erreur(400, `${section} : liste attendue.`);
      if (section === 'services') historiserServices(f, valeur, auteur);
      f[section] = valeur;
    } else if (V.PROFILS[section]) {
      // Volet spécifique : seulement celui qui correspond au type de la structure.
      const profil = V.profilDe(e);
      if (profil !== section) {
        throw erreur(400, profil
          ? `Le volet « ${section} » ne s’applique pas à un(e) ${e.type} : utilisez le volet « ${profil} ».`
          : `Aucun volet spécifique pour le type « ${e.type} ».`);
      }
      if (!estObjet(valeur)) throw erreur(400, `${section} : objet attendu.`);
      const connues = V.PROFILS[section].sections.map((s) => s.cle);
      const inconnues = Object.keys(valeur).filter((k) => !connues.includes(k));
      if (inconnues.length) throw erreur(400, `Rubriques inconnues du volet « ${section} » : ${inconnues.join(', ')}.`);
      if (!f[section]) f[section] = {};
      for (const k of Object.keys(valeur)) f[section][k] = valeur[k];
    } else if (section === 'populations') {
      if (!Array.isArray(valeur)) throw erreur(400, 'populations : liste attendue.');
      // Une année = un enregistrement ; les années déjà saisies sont conservées (jamais supprimées).
      for (const p of valeur) {
        const annee = Number(p?.annee);
        if (!Number.isInteger(annee)) throw erreur(400, 'Population : année de référence obligatoire.');
        const i = f.populations.findIndex((x) => x.annee === annee);
        const ligne = { ...p, annee, saisiPar: auteur, saisiLe: new Date() };
        if (i >= 0) f.populations.splice(i, 1, ligne);
        else f.populations.push(ligne);
      }
      f.populations.sort((a, b) => a.annee - b.annee);
    } else {
      if (!estObjet(valeur)) throw erreur(400, `${section} : objet attendu.`);
      const champs = droit === true ? Object.keys(valeur) : Object.keys(valeur).filter((k) => droit.includes(k));
      const refuses = Object.keys(valeur).filter((k) => !champs.includes(k));
      if (refuses.length) throw erreur(403, `Champs réservés au comité de pilotage : ${refuses.join(', ')}.`);
      for (const k of champs) {
        if (section === 'organisation' && R.RESPONSABLES[k]) historiserResponsable(f, k, valeur[k], auteur);
        f[section][k] = valeur[k];
      }
    }
    sections.push(section);
  }
  if (sections.length) f.modifications.push({ par: auteur, le: new Date(), sections });
  synchroniser(e);
  return sections;
}

/** Changement de responsable : l'ancien est gardé dans l'historique, jamais écrasé. */
function historiserResponsable(f, cle, nouveau, auteur) {
  const ancien = f.organisation?.[cle]?.toObject?.() ?? f.organisation?.[cle] ?? {};
  if (!estObjet(nouveau) || memePersonne(ancien, nouveau)) return;
  if (!R.nomPersonne(ancien)) return; // première saisie : rien à historiser
  f.historiqueResponsables.push({ role: R.RESPONSABLES[cle], ancien, nouveau, le: new Date(), par: auteur });
}

/** Changements d'existence, de disponibilité ou de fonctionnalité d'un service : historisés. */
function historiserServices(f, nouveaux, auteur) {
  const avant = new Map((f.services ?? []).map((s) => [s.service, s]));
  for (const n of nouveaux) {
    if (!n?.service) continue;
    const a = avant.get(n.service);
    for (const champ of ['existence', 'disponible', 'disponibilite', 'fonctionnel']) {
      const ancien = a?.[champ] ?? null;
      const nouveau = n[champ] ?? null;
      if (ancien !== nouveau && (a || nouveau != null)) {
        f.historiqueServices.push({ service: n.service, champ, ancien, nouveau, le: new Date(), par: auteur });
      }
    }
  }
}

/** Structure de référence et structures desservies : établissements existants, autres que celui-ci. */
async function erreurRattachement(e) {
  const r = e.fiche?.rattachementSanitaire;
  if (!r) return null;
  const ids = [r.structureReferenceId, ...(r.structuresDesservies ?? [])].filter(Boolean).map(String);
  if (!ids.length) return null;
  if (ids.includes(e.id)) return 'Rattachement : une structure ne peut pas se référer ou se desservir elle-même.';
  if (ids.some((id) => !mongoose.isValidObjectId(id))) return 'Rattachement : structure inconnue (choisir dans le référentiel).';
  const trouvees = await Etablissement.countDocuments({ _id: { $in: [...new Set(ids)] } });
  return trouvees === new Set(ids).size ? null : 'Rattachement : structure inconnue (choisir dans le référentiel).';
}

/** Champs de l'établissement déduits de la fiche (utilisés par le reste de la plateforme). */
function synchroniser(e) {
  const f = e.fiche;
  const org = f.organisation ?? {};
  if (org.statutJuridique) e.secteur = R.SECTEUR_DU_STATUT[org.statutJuridique];
  const nom = R.nomPersonne(org.responsable);
  if (nom) e.responsable = nom;
  if (org.responsable?.fonction) e.fonctionResponsable = org.responsable.fonction;
  if (f.infrastructures?.litsTotal != null) e.lits = f.infrastructures.litsTotal;
  if (f.services?.length) {
    const services = R.servicesPlateforme(f.services);
    if (services.length) e.services = services;
  }
  if (!f.identification.categorie && e.type) f.identification.categorie = R.CATEGORIE_DU_TYPE[e.type] ?? null;
}

/**
 * Cascade Province → Zone → Aire : une aire de santé appartient à une seule zone. Refuse une aire
 * connue (référentiel géographique ou autre établissement de la province) dans une autre zone.
 */
async function erreurAire(e) {
  const aire = String(e.aireSante || '').trim();
  // Zone principale : la première sélectionnée (pas encore recopiée dans zoneSante à la création).
  const zone = e.zonesSante?.[0] ?? e.zoneSante;
  if (!aire || !zone) return null;
  const motif = new RegExp(`^${aire.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const autres = await Etablissement.find({ _id: { $ne: e._id }, province: e.province, aireSante: motif }).select('zoneSante');
  const autreZone = autres.find((x) => x.zoneSante && x.zoneSante !== zone);
  if (autreZone) return `L’aire de santé « ${aire} » appartient à la zone de santé ${autreZone.zoneSante}, pas à ${zone}.`;
  const aires = await EntiteGeographique.find({ niveau: 'Aire de santé', nom: motif, actif: true }).select('parentCode');
  if (aires.length) {
    const zones = await EntiteGeographique.find({ code: { $in: aires.map((a) => a.parentCode) }, niveau: 'Zone de santé' }).select('nom');
    if (zones.length && !zones.some((z) => z.nom.toLowerCase() === zone.toLowerCase())) {
      return `L’aire de santé « ${aire} » appartient à la zone de santé ${zones[0].nom}, pas à ${zone}.`;
    }
  }
  return null;
}

/** Aires de santé connues d'une zone (suggestions du formulaire). */
async function airesDeZone(province, zone) {
  const [etabs, zones] = await Promise.all([
    Etablissement.find({ province, zoneSante: zone, aireSante: { $nin: ['', null] } }).select('aireSante'),
    EntiteGeographique.find({ niveau: 'Zone de santé', nom: zone }).select('code'),
  ]);
  const ref = zones.length ? await EntiteGeographique.find({ niveau: 'Aire de santé', parentCode: { $in: zones.map((z) => z.code) }, actif: true }).select('nom') : [];
  return [...new Set([...etabs.map((x) => x.aireSante.trim()), ...ref.map((a) => a.nom)])].sort((a, b) => a.localeCompare(b, 'fr'));
}

/** Coefficients démographiques validés (module Épidémiologie), en vigueur, par cible. */
async function coefficientsValides() {
  const jour = new Date().toISOString().slice(0, 10);
  const liste = await CoefficientDemographique.find({ cible: { $in: ['FE', 'NA', 'NS'] }, statut: 'Validé', entiteCode: 'CD' })
    .sort({ dateDebut: -1, version: -1 }).lean();
  const parCible = {};
  for (const c of liste) {
    if (parCible[c.cible] || c.dateDebut > jour || (c.dateFin && c.dateFin < jour)) continue;
    parCible[c.cible] = { ...c, validePar: c.decision?.par?.nom ?? null, valideLe: c.decision?.le ?? null };
  }
  return parCible;
}

/** Activités réalisées sur les 30 derniers jours (accouchements, consultations CPN). */
async function activitesRealisees(e) {
  const depuis = new Date(Date.now() - 30 * 86400000);
  const [accouchements, cpn] = await Promise.all([
    Accouchement.countDocuments({ etablissementId: e.id, 'accouchement.heure': { $gte: depuis } }),
    Consultation.countDocuments({ etablissementId: e.id, date: { $gte: depuis } }),
  ]);
  return { accouchements, cpn };
}

/** RECO enregistrés sur la plateforme pour l'aire de santé de l'établissement (comptés à part des salariés). */
async function recosPlateforme(e) {
  const filtre = { $or: [{ etablissementId: e.id }, ...(e.aireSante ? [{ aireSante: e.aireSante }] : [])] };
  const [total, actifs] = await Promise.all([
    Reco.countDocuments(filtre),
    Reco.countDocuments({ ...filtre, statut: 'Actif' }),
  ]);
  return { total, actifs };
}

/** Rattachement : structure de référence, structures desservies et structures qui réfèrent vers celle-ci. */
async function structuresLiees(e) {
  const r = e.fiche?.rattachementSanitaire ?? {};
  const ids = [r.structureReferenceId, ...(r.structuresDesservies ?? [])].filter((id) => id && mongoose.isValidObjectId(id));
  const [liees, referentes] = await Promise.all([
    ids.length ? Etablissement.find({ _id: { $in: ids } }).select('nom codeAmi type zoneSante') : [],
    Etablissement.find({ 'fiche.rattachementSanitaire.structureReferenceId': e.id }).select('nom codeAmi type zoneSante'),
  ]);
  const resume = (x) => ({ id: x.id, nom: x.nom, codeAmi: x.codeAmi ?? null, type: x.type, zoneSante: x.zoneSante });
  const parId = new Map(liees.map((x) => [x.id, resume(x)]));
  return {
    structureReference: r.structureReferenceId ? parId.get(String(r.structureReferenceId)) ?? null : null,
    structuresDesservies: (r.structuresDesservies ?? []).map((id) => parId.get(String(id))).filter(Boolean),
    structuresReferentes: referentes.map(resume),
  };
}

/** Fiche complète avec ses calculs (étapes 4, 5, 8, 9 et 10). */
async function ficheComplete(e, { role }) {
  const fiche = e.fiche ? e.fiche.toObject() : null;
  const [coefficients, realisees, recos, liees] = await Promise.all([
    coefficientsValides(), activitesRealisees(e), recosPlateforme(e), structuresLiees(e),
  ]);
  const cibles = R.calculsCibles(e, coefficients);
  if (fiche) {
    // Pièces jointes : stockage privé, liens temporaires.
    const signer = async (p) => (p?.cle ? { ...p, cle: undefined, url: await urlSignee(p.cle).catch(() => null) } : null);
    if (fiche.organisation?.autorisation?.piece) fiche.organisation.autorisation.piece = await signer(fiche.organisation.autorisation.piece);
    if (fiche.organisation?.agrement?.piece) fiche.organisation.agrement.piece = await signer(fiche.organisation.agrement.piece);
    if (fiche.identification?.acteCreation?.piece) fiche.identification.acteCreation.piece = await signer(fiche.identification.acteCreation.piece);
    for (const q of fiche.equipements ?? []) if (q.preuve) q.preuve = await signer(q.preuve);
    fiche.circuit.pieces = await Promise.all((fiche.circuit.pieces ?? []).map(signer));
  }
  const profil = V.profilDe(e);
  return {
    etablissement: e.toJSON(),
    fiche,
    role,
    champsChef: R.CHAMPS_CHEF,
    rattachement: { ...R.rattachement(e), ...liees },
    /** Volet spécifique à afficher (hôpital / centre de santé) et sa description pour le formulaire dynamique. */
    profil,
    formulaire: V.formulaire(profil),
    calculs: {
      completude: R.completude(e),
      champsManquants: R.champsManquants(e),
      controle: R.controler(e),
      equipements: R.calculsEquipements(fiche?.equipements),
      rh: R.calculsRh(fiche?.agents, fiche?.effectifsAttendus),
      effectifs: R.calculsEffectifs(fiche?.effectifs),
      recos: { declares: fiche?.recos ?? null, plateforme: recos },
      cibles,
      capacites: R.calculsCapacites(e, cibles, realisees),
      modulesPrevus: R.modulesPrevus(e),
      modulesActifs: R.modulesActifs(e),
    },
  };
}

async function trouver(id) {
  const e = mongoose.isValidObjectId(id) && await Etablissement.findById(id);
  if (!e) throw erreur(404, 'Établissement introuvable.');
  return e;
}

/** Le médecin chef ne voit et ne complète que la fiche de son établissement. */
function verifierChef(req, e) {
  const s = req.soignant;
  if (s.role !== ROLE_CHEF || !s.affectations.some((a) => a.etablissementId === e.id)) {
    throw erreur(403, 'La fiche de l’établissement est complétée par son médecin chef.');
  }
}

async function enregistrer(e) {
  try {
    await e.validate();
  } catch (err) {
    throw erreur(400, messageValidation(err));
  }
  e.fiche.circuit.completude = R.completude(e);
  await e.save();
}

const repondre = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (!err.status) throw err;
    res.status(err.status).json({ message: err.message, ...(err.erreurs ? { erreurs: err.erreurs, avertissements: err.avertissements } : {}) });
  }
};

// --- Lecture et saisie -------------------------------------------------------------------------

exports.obtenirComite = repondre(async (req, res) => {
  res.json(await ficheComplete(await trouver(req.params.id), { role: 'comite' }));
});

exports.obtenirChef = repondre(async (req, res) => {
  const e = await trouver(req.params.id);
  verifierChef(req, e);
  res.json(await ficheComplete(e, { role: 'chef' }));
});

/** Statuts où une modification du comité renvoie la fiche en brouillon (à vérifier de nouveau). */
const A_REVERIFIER = ['En attente de vérification', 'En attente de validation', 'Validée'];

exports.modifierComite = repondre(async (req, res) => {
  const e = await trouver(req.params.id);
  const auteur = acteur(req);
  initialiserFiche(e, auteur);
  appliquerFiche(e, req.body.fiche ?? req.body, auteur, 'comite');
  marquerAuteur(e, auteur);
  const aire = await erreurAire(e) ?? await erreurRattachement(e);
  if (aire) throw erreur(400, aire);
  await enregistrer(e);
  res.json(await ficheComplete(e, { role: 'comite' }));
});

exports.modifierChef = repondre(async (req, res) => {
  const e = await trouver(req.params.id);
  verifierChef(req, e);
  const auteur = acteur(req);
  initialiserFiche(e, auteur);
  // Champs facultatifs seulement : le statut de la fiche ne change pas.
  appliquerFiche(e, req.body.fiche ?? req.body, auteur, 'chef');
  await enregistrer(e);
  res.json(await ficheComplete(e, { role: 'chef' }));
});

/** Membre du comité ayant saisi la fiche : il ne pourra pas la vérifier. */
function marquerAuteur(e, auteur) {
  const c = e.fiche.circuit;
  if (auteur.type === 'comite' && !c.auteurs.includes(auteur.id)) c.auteurs.push(auteur.id);
  if (A_REVERIFIER.includes(c.statut)) changerStatut(e, 'Brouillon', auteur, 'Fiche modifiée après soumission', 'La fiche doit être soumise de nouveau.');
}

/** Utilisé à la création et à la modification de l'établissement (formulaire du comité). */
async function appliquerDepuisFormulaire(e, brut, req, { creation }) {
  if (brut === undefined || brut === '') return;
  let d;
  try {
    d = typeof brut === 'string' ? JSON.parse(brut) : brut;
  } catch {
    throw erreur(400, 'Fiche AMI invalide.');
  }
  const auteur = acteur(req);
  initialiserFiche(e, auteur, { creation });
  appliquerFiche(e, d, auteur, 'comite');
  marquerAuteur(e, auteur);
  const aire = await erreurAire(e) ?? await erreurRattachement(e);
  if (aire) throw erreur(400, aire);
  e.fiche.circuit.completude = R.completude(e);
}

exports.aires = repondre(async (req, res) => {
  const province = String(req.query.province || '');
  const zone = String(req.query.zone || '');
  res.json(province && zone ? await airesDeZone(province, zone) : []);
});

// --- Pièces jointes -------------------------------------------------------------------------------

/**
 * Pièces jointes, selon `type` : autorisation de fonctionnement et agrément (étape 3), acte de
 * création (étape 1), preuve de recensement d'un équipement (`index` de la ligne) ou pièce
 * justificative de vérification (étape 10, avec type, numéro, date, émetteur, validité).
 */
const TYPES_PIECE_FICHE = ['autorisation', 'agrement', 'acteCreation', 'equipement', 'verification'];

exports.ajouterPiece = repondre(async (req, res) => {
  const e = await trouver(req.params.id);
  if (!req.file) throw erreur(400, 'Aucun fichier reçu.');
  const type = TYPES_PIECE_FICHE.includes(req.body.type) ? req.body.type : 'autorisation';
  const auteur = acteur(req);
  initialiserFiche(e, auteur);
  const f = e.fiche;
  const index = Number(req.body.index);
  if (type === 'verification' && f.circuit.pieces.length >= 10) throw erreur(400, '10 pièces justificatives au maximum.');
  if (type === 'equipement' && !(Number.isInteger(index) && f.equipements[index])) throw erreur(400, 'Équipement introuvable (index).');
  const envoye = await envoyerFichier(req.file, DOSSIER_PIECES);
  const piece = { url: envoye.url, cle: envoye.cle, nom: req.file.originalname };
  let ancienne = null;
  const remplacer = (objet, cle = 'piece') => {
    ancienne = objet[cle]?.cle ?? null;
    objet[cle] = piece;
    marquerAuteur(e, auteur);
  };
  if (type === 'autorisation') remplacer(f.organisation.autorisation);
  else if (type === 'agrement') remplacer(f.organisation.agrement);
  else if (type === 'acteCreation') remplacer(f.identification.acteCreation);
  else if (type === 'equipement') remplacer(f.equipements[index], 'preuve');
  else {
    const d = nettoyer(req.body);
    f.circuit.pieces.push({
      ...piece, type: d.typePiece ?? null, numero: d.numero ?? '', date: d.date ?? null, emetteur: d.emetteur ?? '',
      validite: d.validite ?? null, accesRestreint: d.accesRestreint !== 'false' && d.accesRestreint !== false,
    });
  }
  try {
    await e.save();
  } catch (err) {
    await supprimerFichier(piece.cle).catch(() => {});
    throw err;
  }
  if (ancienne) await supprimerFichier(ancienne).catch(() => {});
  res.status(201).json(await ficheComplete(e, { role: 'comite' }));
});

// --- Étape 10 : circuit de validation -------------------------------------------------------------

function changerStatut(e, vers, auteur, action, motif = '', dateEffet = null) {
  const c = e.fiche.circuit;
  c.historique.push({ de: c.statut, vers, action, motif, par: auteur, le: new Date(), dateEffet: dateEffet || new Date().toISOString().slice(0, 10) });
  c.statut = vers;
}

/** Date d'effet facultative d'une décision (AAAA-MM-JJ). */
function dateEffet(d) {
  const v = String(d?.dateEffet ?? '').trim();
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw erreur(400, 'Date d’effet invalide (AAAA-MM-JJ attendu).');
  return v;
}

/** Doublons : { bloquants } (code SNIS déjà attribué) et { possibles } (mêmes coordonnées GPS). */
async function doublons(e) {
  const bloquants = [];
  const pb = [];
  const code = e.fiche.identification?.codeSnis;
  if (code && await Etablissement.exists({ _id: { $ne: e._id }, 'fiche.identification.codeSnis': code })) {
    bloquants.push(`Étape 1 · Le code SNIS / DHIS2 ${code} est déjà attribué à un autre établissement.`);
  }
  if (e.latitude != null && e.longitude != null
    && await Etablissement.exists({ _id: { $ne: e._id }, latitude: e.latitude, longitude: e.longitude })) {
    pb.push('Étape 1 · Un autre établissement a exactement les mêmes coordonnées GPS (doublon possible).');
  }
  return { bloquants, possibles: pb };
}

const exigerStatut = (e, ...statuts) => {
  if (!statuts.includes(e.fiche.circuit.statut)) {
    throw erreur(409, `Action impossible : la fiche est « ${e.fiche.circuit.statut} » (attendu : ${statuts.join(' ou ')}).`);
  }
};
const texteRequis = (v, libelle) => {
  const t = String(v ?? '').trim();
  if (!t) throw erreur(400, `${libelle} : obligatoire.`);
  return t;
};

const ACTIONS = {
  /** 1-2. Brouillon → contrôle automatique (champs, doublons, cohérences) → vérification. */
  async soumettre(e, auteur) {
    exigerStatut(e, 'Brouillon', 'À corriger');
    const { erreurs, avertissements } = R.controler(e);
    const aire = await erreurAire(e);
    if (aire) erreurs.push(`Étape 2 · ${aire}`);
    const rattachement = await erreurRattachement(e);
    if (rattachement) erreurs.push(rattachement);
    const dbl = await doublons(e);
    erreurs.push(...dbl.bloquants);
    // Un doublon seulement possible n'est pas bloquant : il est signalé au vérificateur.
    avertissements.push(...dbl.possibles);
    e.fiche.circuit.controle = { le: new Date(), erreurs, avertissements };
    if (erreurs.length) {
      await e.save();
      throw erreur(422, `Contrôle automatique : ${erreurs.length} point(s) à corriger avant la vérification.`, { erreurs, avertissements });
    }
    changerStatut(e, 'En attente de vérification', auteur, 'Soumission (contrôle automatique réussi)');
  },
  /** 3-4. Vérification par le niveau compétent (BCZS / DPS) : conforme, ou à corriger avec motifs. */
  async verifier(e, auteur, d) {
    exigerStatut(e, 'En attente de vérification');
    if (e.fiche.circuit.auteurs.includes(auteur.id)) {
      throw erreur(403, 'Le vérificateur doit être différent de l’auteur de la saisie.');
    }
    const resultat = d.resultat === 'Conforme' ? 'Conforme' : d.resultat === 'Non conforme' ? 'Non conforme' : null;
    if (!resultat) throw erreur(400, 'Résultat du contrôle : Conforme ou Non conforme.');
    const motifs = (Array.isArray(d.motifs) ? d.motifs : []).map((m) => String(m).trim()).filter(Boolean);
    const observations = String(d.observations ?? '').trim();
    if (resultat === 'Non conforme' && !motifs.length && !observations) throw erreur(400, 'Indiquez les motifs de correction.');
    e.fiche.circuit.verification = {
      par: auteur, nom: texteRequis(d.nom, 'Nom du vérificateur'), fonction: texteRequis(d.fonction, 'Fonction du vérificateur'),
      date: texteRequis(d.date, 'Date de vérification'), resultat, observations,
    };
    if (resultat === 'Conforme') {
      e.fiche.circuit.motifsCorrection = [];
      changerStatut(e, 'En attente de validation', auteur, 'Vérification conforme', observations);
    } else {
      e.fiche.circuit.motifsCorrection = motifs.length ? motifs : [observations];
      changerStatut(e, 'À corriger', auteur, 'Vérification non conforme', e.fiche.circuit.motifsCorrection.join(' ; '));
    }
  },
  /** 5. Validation par l'autorité habilitée. */
  async valider(e, auteur, d) {
    exigerStatut(e, 'En attente de validation');
    e.fiche.circuit.validation = {
      par: auteur, nom: texteRequis(d.nom, 'Nom du valideur'), fonction: String(d.fonction ?? '').trim(),
      date: texteRequis(d.date, 'Date de validation'), statutFinal: String(d.statutFinal ?? 'Validée').trim() || 'Validée',
    };
    changerStatut(e, 'Validée', auteur, 'Validation', String(d.observations ?? '').trim(), dateEffet(d));
  },
  /** 6-7. Activation : modules ouverts selon l'étape 6, QR code généré. */
  async activer(e, auteur, d) {
    exigerStatut(e, 'Validée');
    e.fiche.circuit.qrCode = await QRCode.toDataURL(
      `AMI Santé Connect\nCode AMI : ${e.codeAmi}\n${e.nom}\n${e.province} · ZS ${e.zoneSante}${e.aireSante ? ` · AS ${e.aireSante}` : ''}`,
      { errorCorrectionLevel: 'M', margin: 1, width: 320 },
    );
    e.fiche.circuit.activeLe = new Date();
    changerStatut(e, 'Active', auteur, `Activation (modules : ${R.modulesPrevus(e).join(', ') || 'aucun'})`, '', dateEffet(d));
  },
  async suspendre(e, auteur, d) {
    exigerStatut(e, 'Active');
    changerStatut(e, 'Suspendue', auteur, 'Suspension', texteRequis(d.motif, 'Motif de la suspension'), dateEffet(d));
  },
  async reactiver(e, auteur, d) {
    exigerStatut(e, 'Suspendue');
    changerStatut(e, 'Active', auteur, 'Réactivation', '', dateEffet(d));
  },
  /** Rejet du dossier (vérification ou validation) : motif obligatoire. */
  async rejeter(e, auteur, d) {
    exigerStatut(e, 'En attente de vérification', 'En attente de validation');
    if (e.fiche.circuit.auteurs.includes(auteur.id)) throw erreur(403, 'Le rejet est décidé par un utilisateur différent de l’auteur de la saisie.');
    changerStatut(e, 'Rejetée', auteur, 'Rejet', texteRequis(d.motif, 'Motif du rejet'), dateEffet(d));
  },
  /** Fermeture de la structure : motif obligatoire, modules fermés. */
  async fermer(e, auteur, d) {
    if (['Fermée', 'Archivée'].includes(e.fiche.circuit.statut)) throw erreur(409, `La fiche est déjà « ${e.fiche.circuit.statut} ».`);
    changerStatut(e, 'Fermée', auteur, 'Fermeture', texteRequis(d.motif, 'Motif de la fermeture'), dateEffet(d));
  },
  async archiver(e, auteur, d) {
    if (e.fiche.circuit.statut === 'Archivée') throw erreur(409, 'La fiche est déjà archivée.');
    changerStatut(e, 'Archivée', auteur, 'Archivage', texteRequis(d.motif, 'Motif de l’archivage'), dateEffet(d));
  },
  /** Fiche archivée, rejetée ou fermée : retour en brouillon (nouveau circuit complet). */
  async rouvrir(e, auteur) {
    exigerStatut(e, 'Archivée', 'Rejetée', 'Fermée');
    changerStatut(e, 'Brouillon', auteur, 'Réouverture');
  },
};

exports.circuit = repondre(async (req, res) => {
  const action = ACTIONS[req.params.action];
  if (!action) throw erreur(404, 'Action inconnue.');
  const e = await trouver(req.params.id);
  const auteur = acteur(req);
  initialiserFiche(e, auteur);
  await action(e, auteur, req.body || {});
  await enregistrer(e);
  res.json(await ficheComplete(e, { role: 'comite' }));
});

Object.assign(exports, { appliquerDepuisFormulaire, erreurAire, ficheComplete, ROLE_CHEF });
