const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const Accouchement = require('../models/Accouchement');
const Patiente = require('../models/Patiente');
const Grossesse = require('../models/Grossesse');
const Enfant = require('../models/Enfant');
const RendezVous = require('../models/RendezVous');
const Soignant = require('../models/Soignant');
const { auteurDe } = require('../models/commun');
const { journaliser } = require('../config/audit');
const acc = require('../config/accouchement');
const cpn = require('../config/cpn');
const partogramme = require('../config/partogramme');
const presence = require('../config/presence');
const { urlSignee, supprimerFichier } = require('../config/r2');
const { jourKinshasa } = require('../config/vaccination');
const { trouverPatiente, champsAdministratifs, chercherDoublons, motDePasseValide } = require('./patientes');
const { verifierDoublon } = require('./rendezVous');
const enfants = require('./enfants');
const suiviPrenatal = require('./suiviPrenatal');
const { erreur, texte, nombre, instant, jour, objet, T, N, B, C, D, J, lire, fusionner, valider, pasDansLeFutur } = require('./saisie');

const { STATUTS_ACTIFS } = RendezVous;
const codes = (liste) => liste.map((x) => x.code);
const HEURE = 3600000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const heuresEntre = (debut, fin) => (debut ? Math.round(((fin - debut) / HEURE) * 100) / 100 : null);

// Spécifications des formulaires (liste blanche des champs, convertis).
const SPEC_ADMISSION = {
  nom: T(120), postnom: T(120), prenom: T(120), age: N, occupation: T(120),
  etatMatrimonial: C(cpn.ETATS_CIVILS), provenance: C(codes(acc.PROVENANCES)), provenancePrecision: T(200),
  nomPartenaire: T(120), adresse: T(300), personneAPrevenir: { nom: T(120), telephone: T(40) },
  motif: T(), groupeSanguin: C(cpn.GROUPES_SANGUINS), rhesus: C(cpn.RHESUS), statutHb: C(acc.STATUTS_HB),
  gestite: N, parite: N, avortements: N, enfantsVivants: N, ddr: J, dpa: J,
  vih: { conseillee: B, testee: B, informee: B, resultat: C(acc.RESULTATS_VIH) },
  arv: { regime: T(200), depuisLe: J },
  debutTravail: D,
  antecedents: {
    medicoChirurgicaux: T(),
    gynecoObstetricaux: {
      vivants: N, morts: N, mortNes: N, eutocies: N, dystocies: N, bebesPlus4kg: N, autres: T(),
      cesariennes: (v) => (Array.isArray(v) ? v : []).slice(0, 10).map((c) => ({ annee: nombre(objet(c).annee), indication: texte(objet(c).indication, 300) })),
    },
  },
};
const SPEC_EXAMEN = {
  physique: {
    poidsKg: N, tailleCm: N, temperature: N, pouls: N, taSystolique: N, taDiastolique: N, oedemes: B,
    conjonctives: C(acc.CONJONCTIVES), etatGeneral: C(acc.ETATS_GENERAUX),
    systemes: Object.fromEntries(acc.SYSTEMES.map(({ code }) => [code, T(1000)])),
  },
  obstetrical: {
    hauteurUterineCm: N, presentation: C(acc.PRESENTATIONS), position: T(60), bcf: N, contractions10min: N, contractions: T(300),
    mouvementsFoetauxActifs: B, speculum: T(1000), colAspect: T(300),
    toucherVaginal: { effacementPct: N, dilatationCm: N, oedemeCol: B },
    pocheEaux: { etat: C(acc.ETATS_POCHE), rompueLe: D, aspectLiquide: C(acc.ASPECTS_LA) },
    engagement: C(acc.ENGAGEMENTS), bassin: C(acc.BASSINS),
  },
  laboratoire: Object.fromEntries(acc.EXAMENS_LABO_ENTREE.map(({ code }) => [code, T(300)])),
  conclusion: T(), pronostic: T(), conduiteATenir: T(),
};
const SPEC_SURVEILLANCE = {
  saignement: C(acc.SAIGNEMENTS), contractions10min: N, dureeContractionsSec: N, bcf: N, temperature: N, pouls: N,
  taSystolique: N, taDiastolique: N, diurese: T(200), dilatationCm: N, effacementPct: N, affection: T(1000), traitements: T(1000),
  membranes: C(acc.MEMBRANES), liquideAmniotique: C(acc.ASPECTS_LA), ocytocine: { uParMl: N, gouttesMin: N },
  medicamentsIV: T(1000), engagement: C(codes(acc.ENGAGEMENTS_PARTOGRAMME)), incident: T(1000),
};
const SPEC_ACCOUCHEMENT = {
  mode: C(acc.MODES_ACCOUCHEMENT), heure: D, multiple: B, nombreEnfants: N,
  dechirure: { presente: B, degre: N }, episiotomie: B, indicationCesarienne: T(1000), accoucheur: T(120), assiste: T(120),
  delivrance: {
    ocytocine10UI: { administree: B, heure: D }, tractionControlee: B, massageUterin: B,
    mode: C(acc.MODES_DELIVRANCE), heure: D, placenta: { complet: B, aspect: T(300) }, membranesCompletes: B,
    pertesSangMl: N, hemorragie: C(['Physiologique', 'Pathologique']),
  },
};
const SPEC_POST_PARTUM_MERE = {
  taSystolique: N, taDiastolique: N, pouls: N, temperature: N, respiration: N, conscience: T(200),
  saignement: C(acc.SAIGNEMENTS), globeSecurite: B, vessieDiurese: T(200), allaitement: T(200), reactionsPsy: T(300),
};
const SPEC_POST_PARTUM_NN = { respiration: N, coloration: T(100), temperatureAxillaire: N, signesDanger: T(500) };
const SPEC_MESURES = {
  mere: Object.fromEntries(acc.MESURES_SORTIE_MERE.map(({ code }) => [code, B])),
  nouveauNe: Object.fromEntries(acc.MESURES_SORTIE_NOUVEAU_NE.map(({ code }) => [code, B])),
};

async function trouver(id) {
  const a = /^AC-ACC-\d+$/.test(id) ? await Accouchement.findOne({ numero: id })
    : mongoose.isValidObjectId(id) ? await Accouchement.findById(id) : null;
  if (!a) throw erreur(404, 'Dossier d’accouchement introuvable.');
  return a;
}

/** Un dossier clôturé n'est plus modifiable. */
function verifierOuvert(a) {
  if (a.statut === 'Clôturé') throw erreur(409, 'Ce dossier d’accouchement est clôturé.');
}
function verifierAccouchee(a) {
  if (!a.accouchement) throw erreur(409, 'Enregistrez d’abord l’accouchement (module IV).');
}

/** Heure de rupture des membranes : examen d'entrée, sinon première surveillance « Rompues ». */
function ruptureLe(a) {
  return a.examenClinique?.obstetrical?.pocheEaux?.rompueLe
    ?? [...a.surveillances].sort((x, y) => x.le - y.le).find((s) => s.membranes === 'Rompues')?.le
    ?? null;
}

/** Planning de la surveillance post-partum, calculé depuis l'heure de l'accouchement. */
function planningPostPartum(a, maintenant = new Date()) {
  if (!a.accouchement) return null;
  const base = a.accouchement.heure.getTime();
  return acc.CRENEAUX_POST_PARTUM.map((c) => {
    const prevuLe = new Date(base + c.minutes * 60000);
    const faite = a.postPartum.surveillances.find((s) => s.creneau === c.code);
    const statut = faite ? 'Faite' : maintenant < prevuLe ? 'À venir' : maintenant - prevuLe <= 15 * 60000 ? 'À faire' : 'En retard';
    return { code: c.code, libelle: c.libelle, prevuLe, statut, surveillanceId: faite?.id ?? null };
  });
}

/** Éléments manquants pour clore le dossier (vide : clôture possible). */
function manquantsCloture(a, nouveauNes) {
  const manquants = [];
  if (!a.accouchement) manquants.push('Accouchement (module IV)');
  if (!nouveauNes.length) manquants.push('Nouveau-né (module V)');
  else if (a.accouchement?.nombreEnfants && nouveauNes.length < a.accouchement.nombreEnfants) {
    manquants.push(`Nouveau-nés : ${nouveauNes.length} enregistré(s) sur ${a.accouchement.nombreEnfants}`);
  }
  if (!a.postPartum.sortie) manquants.push('Examen de sortie');
  const m = a.postPartum.mesuresPreventives ?? {};
  for (const { code, libelle } of acc.MESURES_SORTIE_MERE) if (m.mere?.[code] == null) manquants.push(`Mesure préventive mère : ${libelle}`);
  for (const { code, libelle } of acc.MESURES_SORTIE_NOUVEAU_NE) if (m.nouveauNe?.[code] == null) manquants.push(`Mesure préventive nouveau-né : ${libelle}`);
  return manquants;
}

/** Dossier complet : partogramme, temps écoulés, planning post-partum et nouveau-nés. */
async function vue(a) {
  const [patiente, grossesse, nouveauNes] = await Promise.all([
    Patiente.findById(a.patienteId),
    Grossesse.findById(a.grossesseId),
    Enfant.find({ accouchementId: a._id }).sort({ rang: 1 }),
  ]);
  const rupture = ruptureLe(a);
  const json = a.toJSON();
  // Tableau horaire : temps écoulé depuis l'arrivée, la rupture et le début du travail.
  json.surveillances = [...a.surveillances].sort((x, y) => x.le - y.le).map((s) => ({
    ...s.toJSON(),
    tempsDepuis: {
      arriveeH: heuresEntre(a.admission.admiseLe, s.le),
      ruptureH: rupture && s.le >= rupture ? heuresEntre(rupture, s.le) : null,
      debutTravailH: a.admission.debutTravail ? heuresEntre(a.admission.debutTravail, s.le) : null,
    },
  }));
  json.partogramme = partogramme.duDossier(a);
  json.planningPostPartum = planningPostPartum(a);
  json.patiente = patiente ? { id: patiente.id, numero: patiente.numero, nom: patiente.nom, postnom: patiente.postnom, prenom: patiente.prenom, photoUrl: await urlSignee(patiente.photoCle) } : null;
  json.nouveauNes = await Promise.all(nouveauNes.map(enfants.resumeAvecPhoto));
  // Suivi prénatal : synthèse en tête du dossier et, tant qu'il est ouvert, valeurs proposées
  // pour les champs encore vides de l'admission et de l'examen d'entrée (à vérifier, puis enregistrer).
  if (patiente) {
    const suivi = await suiviPrenatal.charger(grossesse);
    json.rappelPrenatal = suiviPrenatal.rappel(patiente, grossesse, suivi, a.admission.admiseLe);
    json.preRemplissage = a.statut === 'Clôturé' ? null : {
      admission: suiviPrenatal.admission(patiente, grossesse, suivi),
      examen: a.examenClinique ? null : suiviPrenatal.examen(patiente, suivi),
    };
  }
  json.manquantsCloture = a.statut === 'Clôturé' ? [] : manquantsCloture(a, nouveauNes);
  return json;
}

/** Résumé pour le tableau de la salle de travail. */
function resume(a, patiente, photoUrl = null) {
  const derniere = [...a.surveillances].sort((x, y) => x.le - y.le).at(-1);
  const actives = a.alertes.filter((x) => !x.acquitteeLe);
  const m = partogramme.mesures(a);
  return {
    id: a.id, numero: a.numero, statut: a.statut, etablissementId: a.etablissementId,
    patiente: patiente ? { id: patiente.id, numero: patiente.numero, nom: patiente.nom, postnom: patiente.postnom, prenom: patiente.prenom, photoUrl } : null,
    admiseLe: a.admission.admiseLe,
    phase: m.debutPhaseActive ? 'Active' : 'Latence',
    derniereSurveillance: derniere ? { le: derniere.le, dilatationCm: derniere.dilatationCm, effacementPct: derniere.effacementPct, bcf: derniere.bcf } : null,
    zoneActuelle: partogramme.pointsDilatation(m.surveillances, m.debutPhaseActive).at(-1)?.zone ?? null,
    alertesActives: actives.length,
    alertesCritiques: actives.filter((x) => x.niveau === 'Critique').length,
    accoucheeLe: a.accouchement?.heure ?? null,
    sortieLe: a.postPartum?.sortie?.date ?? null,
  };
}

/** Salle de travail : dossiers ouverts (ou d'un statut / d'une patiente donnés). */
exports.lister = async (req, res) => {
  const filtre = {};
  if (acc.STATUTS_ACCOUCHEMENT.includes(req.query.statut)) filtre.statut = req.query.statut;
  else if (req.query.statut !== 'Tous') filtre.statut = { $ne: 'Clôturé' };
  if (req.query.patienteId) filtre.patienteId = (await trouverPatiente(String(req.query.patienteId)))._id;
  const dossiers = await Accouchement.find(filtre).sort({ 'admission.admiseLe': -1 }).limit(200);
  const patientes = await Patiente.find({ _id: { $in: dossiers.map((a) => a.patienteId) } }).select('numero nom postnom prenom photoCle');
  const parId = new Map(patientes.map((p) => [p.id, p]));
  // Photo d'identification : lien signé temporaire (15 min), calculé localement.
  const photos = new Map(await Promise.all(patientes.map(async (p) => [p.id, await urlSignee(p.photoCle)])));
  res.json(dossiers.map((a) => resume(a, parId.get(String(a.patienteId)), photos.get(String(a.patienteId)) ?? null)));
};

/** Alertes non prises en charge des dossiers ouverts (écran de la salle de travail, médecins). */
exports.alertes = async (req, res) => {
  const dossiers = await Accouchement.find({ statut: { $ne: 'Clôturé' }, alertes: { $elemMatch: { acquitteeLe: null } } });
  const patientes = await Patiente.find({ _id: { $in: dossiers.map((a) => a.patienteId) } }).select('numero nom prenom');
  const parId = new Map(patientes.map((p) => [p.id, p]));
  const liste = dossiers.flatMap((a) => {
    const p = parId.get(String(a.patienteId));
    return a.alertes.filter((x) => !x.acquitteeLe).map((x) => ({
      ...x.toJSON(), accouchementId: a.id, numero: a.numero,
      patiente: p ? { id: p.id, numero: p.numero, nom: p.nom, prenom: p.prenom } : null,
    }));
  });
  res.json(liste.sort((x, y) => y.le - x.le));
};

/**
 * Admission directe : femme venue accoucher sans aucun dossier dans la plateforme (pas de CPN).
 * Dossier patiente minimal (identité, âge, contact) et compte de l'application patiente (e-mail et
 * mot de passe choisis par elle, comme à l'enregistrement CPN) pour suivre son bébé ; la photo
 * pourra être ajoutée plus tard. Renvoie null après avoir répondu 409 si des dossiers possiblement
 * identiques existent et que le soignant n'a pas confirmé.
 */
async function patienteAdmissionDirecte(req, res) {
  const d = objet(req.body.nouvellePatiente);
  const champs = champsAdministratifs({
    nom: d.nom, postnom: d.postnom, prenom: d.prenom, dateNaissance: d.dateNaissance, ageDeclare: d.ageDeclare,
    telephone: d.telephone, contactUrgence: objet(d.contactUrgence), adresse: objet(d.adresse), email: d.email,
  });
  if (!champs.nom) throw erreur(400, 'Le nom de la patiente est obligatoire.');
  if (!champs.dateNaissance && champs.ageDeclare == null) throw erreur(400, 'Date de naissance ou âge de la patiente obligatoire.');
  if (!champs.email || !EMAIL.test(champs.email)) throw erreur(400, 'Adresse e-mail de la patiente obligatoire et valide (application patiente).');
  const motDePasse = objet(req.body.compte).motDePasse;
  if (!motDePasseValide(motDePasse)) throw erreur(400, 'Mot de passe de la patiente trop faible : 8 caractères au moins, avec des lettres et des chiffres.');
  const memeEmail = await Patiente.findOne({ email: champs.email });
  if (memeEmail) {
    res.status(409).json({
      message: `Cette adresse e-mail appartient déjà au dossier ${memeEmail.numero} : si c’est la même patiente, choisissez son dossier.`,
      emailExistant: true,
      doublons: [{
        id: memeEmail.id, numero: memeEmail.numero, nom: memeEmail.nom, postnom: memeEmail.postnom, prenom: memeEmail.prenom,
        age: memeEmail.age(), telephoneMasque: memeEmail.telephoneMasque(), commune: memeEmail.adresse?.commune ?? '',
      }],
    });
    return null;
  }
  const doublons = await chercherDoublons(champs);
  if (doublons.length && req.body.confirmerMalgreDoublons !== true) {
    res.status(409).json({ message: 'Dossier(s) existant(s) possiblement identique(s) : si c’est la même patiente, choisissez son dossier.', doublons });
    return null;
  }
  return new Patiente({
    ...champs,
    ageDeclareLe: champs.ageDeclare != null ? new Date().toISOString().slice(0, 10) : null,
    etablissementId: req.etablissementId ?? null,
    enregistreeVia: 'Admission directe',
    motDePasse: await bcrypt.hash(motDePasse, 12),
    espaceEnLigne: 'Activé',
    creePar: auteurDe(req.soignant),
    numero: await Patiente.prochainNumero(),
  });
}

/**
 * Module 1 — Admission en salle de travail : patiente enregistrée (`patienteId`) ou femme venue
 * directement accoucher sans dossier (`nouvellePatiente`). Sans grossesse en cours dans la
 * plateforme (arrivée directement en travail), une grossesse est ouverte, non datée.
 */
exports.admettre = async (req, res) => {
  const directe = !req.body?.patienteId && req.body?.nouvellePatiente;
  const p = directe ? await patienteAdmissionDirecte(req, res) : await trouverPatiente(String(req.body?.patienteId || ''));
  if (!p) return;
  const auteur = auteurDe(req.soignant);
  let g = p.isNew ? null : await Grossesse.findOne({ patienteId: p._id, statut: 'En cours' }).sort({ numero: -1 });
  if (g) {
    const existant = await Accouchement.findOne({ grossesseId: g._id }).select('numero');
    if (existant) throw erreur(409, `Un dossier d’accouchement existe déjà pour cette grossesse (${existant.numero}).`, { accouchementId: existant.id });
  }
  const saisie = lire(SPEC_ADMISSION, req.body.admission);
  const admiseLe = pasDansLeFutur(instant(objet(req.body.admission).admiseLe, 'Heure d’admission') ?? new Date(), 'L’admission');
  const admission = { ...fusionner(suiviPrenatal.admission(p, g, await suiviPrenatal.charger(g)), saisie), admiseLe, admisePar: auteur };
  if (!g) {
    const derniere = await Grossesse.findOne({ patienteId: p._id }).sort({ numero: -1 }).select('numero');
    g = new Grossesse({ patienteId: p._id, numero: (derniere?.numero ?? 0) + 1, creePar: auteur });
  }
  const a = new Accouchement({
    numero: await Accouchement.prochainNumero(),
    patienteId: p._id, grossesseId: g._id, etablissementId: req.etablissementId,
    admission, creePar: auteur,
  });
  if (p.isNew) await valider(p);
  await valider(a);
  // Sans transaction (MongoDB autonome) : en cas d'échec, les documents créés ici sont retirés.
  const nouvellePatiente = p.isNew;
  const nouvelleGrossesse = g.isNew;
  try {
    if (nouvellePatiente) await p.save();
    if (nouvelleGrossesse) await g.save();
    await a.save();
  } catch (err) {
    await Promise.all([
      nouvelleGrossesse && Grossesse.deleteOne({ _id: g._id }),
      nouvellePatiente && Patiente.deleteOne({ _id: p._id }),
    ]).catch(() => {});
    if (err.code === 11000) throw erreur(409, 'Identifiant déjà attribué, réessayez.');
    throw err;
  }
  if (nouvellePatiente) await journaliser(req, { action: 'patiente.creation', patienteId: p._id, ressource: { type: 'patiente', id: p.numero }, details: { via: 'Admission directe' } });
  if (nouvelleGrossesse) await journaliser(req, { action: 'grossesse.creation', patienteId: p._id, ressource: { type: 'grossesse', id: g.id } });
  await journaliser(req, { action: 'accouchement.admission', patienteId: p._id, ressource: { type: 'accouchement', id: a.numero } });
  res.status(201).json(await vue(a));
};

exports.obtenir = async (req, res) => {
  const a = await trouver(req.params.id);
  await journaliser(req, { action: 'accouchement.lecture', patienteId: a.patienteId, ressource: { type: 'accouchement', id: a.numero } });
  res.json(await vue(a));
};

/** Correction de l'identité ou de l'anamnèse (champs modifiés journalisés, sans valeurs). */
exports.modifierAdmission = async (req, res) => {
  const a = await trouver(req.params.id);
  verifierOuvert(a);
  const saisie = lire(SPEC_ADMISSION, req.body);
  const champs = Object.keys(saisie);
  if (!champs.length) throw erreur(400, 'Aucun champ à modifier.');
  a.admission = fusionner(a.admission.toObject(), saisie);
  await valider(a);
  await a.save();
  await journaliser(req, { action: 'accouchement.modification', patienteId: a.patienteId, ressource: { type: 'accouchement', id: a.numero }, details: { champs } });
  res.json(await vue(a));
};

/** Module 2 — Examen clinique d'entrée (enregistré ou remplacé ; l'examinateur est le soignant connecté). */
exports.examiner = async (req, res) => {
  const a = await trouver(req.params.id);
  verifierOuvert(a);
  const examineLe = pasDansLeFutur(instant(req.body?.examineLe, 'Heure de l’examen') ?? new Date(), 'L’examen');
  a.examenClinique = { ...lire(SPEC_EXAMEN, req.body), examinateur: auteurDe(req.soignant), examineLe };
  await valider(a);
  await a.save();
  await journaliser(req, { action: 'accouchement.examen', patienteId: a.patienteId, ressource: { type: 'accouchement', id: a.numero } });
  res.json(await vue(a));
};

/** Médecins à notifier : ceux de l'établissement du dossier, sinon tous les médecins actifs. */
async function medecinsANotifier(etablissementId) {
  const base = { role: { $in: Soignant.ROLES_MEDECIN }, statut: 'Actif' };
  let medecins = etablissementId ? await Soignant.find({ ...base, 'affectations.etablissementId': etablissementId }).select('_id') : [];
  if (!medecins.length) medecins = await Soignant.find(base).select('_id');
  return medecins.map((m) => m.id);
}

/**
 * Module 3 — Une ligne de surveillance du travail. La phase active commence à la première
 * dilatation ≥ 4 cm. Les alertes (BCF, zones jaune/rouge, stagnation) sont calculées et
 * renvoyées ; la zone rouge est notifiée en temps réel aux médecins.
 */
exports.surveiller = async (req, res) => {
  const a = await trouver(req.params.id);
  verifierOuvert(a);
  if (a.accouchement) throw erreur(409, 'L’accouchement est enregistré : saisissez la surveillance post-partum.');
  const champs = lire(SPEC_SURVEILLANCE, req.body);
  const mesures = Object.entries(champs).filter(([, v]) => v != null && v !== '' && !(typeof v === 'object' && Object.values(v).every((x) => x == null)));
  if (!mesures.length) throw erreur(400, 'Saisissez au moins une mesure.');
  const le = pasDansLeFutur(instant(req.body.le, 'Heure de la surveillance') ?? new Date(), 'La surveillance');
  if (le < new Date(a.admission.admiseLe.getTime() - 60000)) throw erreur(400, 'La surveillance précède l’admission.');

  // Début de la phase active : surveillances, ou examen d'entrée à 4 cm ou plus.
  const debutAvant = partogramme.mesures(a).debutPhaseActive;
  let phase = debutAvant && le >= debutAvant ? 'Active' : 'Latence';
  if (champs.dilatationCm != null && champs.dilatationCm >= partogramme.PHASE_ACTIVE_CM) {
    phase = 'Active';
    if (!a.phaseActiveLe || le < a.phaseActiveLe) a.phaseActiveLe = le;
  }
  a.surveillances.push({ ...champs, le, phase, auteur: auteurDe(req.soignant) });
  const entree = a.surveillances.at(-1);

  const m = partogramme.mesures(a);
  const nouvelles = partogramme.alertesDe(entree, m.surveillances, m.debutPhaseActive, a.alertes);
  for (const alerte of nouvelles) {
    const medecinsNotifies = alerte.notifierMedecins ? await medecinsANotifier(a.etablissementId) : [];
    a.alertes.push({ ...alerte, surveillanceId: entree._id, le, medecinsNotifies });
  }
  const ajoutees = a.alertes.slice(a.alertes.length - nouvelles.length);
  await valider(a);
  await a.save();

  await journaliser(req, { action: 'accouchement.surveillance', patienteId: a.patienteId, ressource: { type: 'accouchement', id: a.numero }, details: { phase } });
  if (ajoutees.length) {
    const patiente = await Patiente.findById(a.patienteId).select('numero nom prenom');
    for (const alerte of ajoutees) {
      await journaliser(req, { action: 'accouchement.alerte', patienteId: a.patienteId, ressource: { type: 'accouchement', id: a.numero }, details: { code: alerte.code } });
      for (const id of alerte.medecinsNotifies) {
        presence.emettre(id, 'accouchement:alerte', {
          accouchementId: a.id, numero: a.numero, alerte: alerte.toJSON(),
          patiente: patiente ? { numero: patiente.numero, nom: patiente.nom, prenom: patiente.prenom } : null,
        });
      }
    }
  }
  res.status(201).json({
    surveillance: entree.toJSON(),
    alertes: ajoutees.map((x) => x.toJSON()),
    partogramme: partogramme.duDossier(a),
  });
};

exports.partogramme = async (req, res) => {
  const a = await trouver(req.params.id);
  res.json(partogramme.duDossier(a));
};

/** Alerte prise en charge : le soignant et l'heure sont conservés. */
exports.acquitterAlerte = async (req, res) => {
  const a = await trouver(req.params.id);
  const alerte = a.alertes.id(req.params.alerteId);
  if (!alerte) throw erreur(404, 'Alerte introuvable.');
  if (alerte.acquitteeLe) throw erreur(409, 'Cette alerte est déjà prise en charge.');
  alerte.acquitteePar = auteurDe(req.soignant);
  alerte.acquitteeLe = new Date();
  await a.save();
  await journaliser(req, { action: 'accouchement.alerte.acquittement', patienteId: a.patienteId, ressource: { type: 'accouchement', id: a.numero }, details: { code: alerte.code } });
  res.json(alerte);
};

/**
 * La grossesse se termine avec l'accouchement : issue (naissance vivante ou mort-né) et mode
 * reportés dans le dossier prénatal, patiente en suivi postnatal.
 */
async function synchroniserGrossesse(a, req) {
  const g = await Grossesse.findById(a.grossesseId);
  if (!g) return;
  const etats = (await Enfant.find({ accouchementId: a._id }).select('etatNaissance')).map((e) => e.etatNaissance);
  const issue = etats.length && etats.every((e) => e === 'Mort-né') ? 'Mort-né' : 'Naissance vivante';
  const premiere = g.statut === 'En cours';
  g.issue = {
    date: jourKinshasa(a.accouchement.heure), lieu: g.issue?.lieu ?? '', issue,
    mode: acc.MODE_ISSUE[a.accouchement.mode],
    complications: g.issue?.complications ?? '', resume: `Dossier d’accouchement ${a.numero}`, orientation: g.issue?.orientation ?? '',
    enregistreePar: g.issue?.enregistreePar ?? auteurDe(req.soignant), enregistreeLe: g.issue?.enregistreeLe ?? new Date(),
  };
  g.statut = 'Terminée';
  await g.save();
  if (premiere) {
    await Patiente.updateOne({ _id: a.patienteId }, { statut: 'Suivi postnatal' });
    await journaliser(req, { action: 'grossesse.issue', patienteId: a.patienteId, ressource: { type: 'grossesse', id: g.id }, details: { issue } });
  }
}

/**
 * Module 4 — Accouchement et délivrance (enregistré ou corrigé tant que le dossier est ouvert).
 * Les nouveau-nés peuvent être transmis en même temps (`nouveauNes`) ou ajoutés ensuite.
 */
exports.accoucher = async (req, res) => {
  const a = await trouver(req.params.id);
  verifierOuvert(a);
  const saisie = lire(SPEC_ACCOUCHEMENT, req.body);
  const donnees = fusionner(a.accouchement?.toObject() ?? {}, saisie);
  if (!donnees.mode) throw erreur(400, 'Type d’accouchement requis.');
  if (!donnees.heure) throw erreur(400, 'Heure de l’accouchement requise.');
  pasDansLeFutur(donnees.heure, 'L’accouchement');
  if (donnees.heure < a.admission.admiseLe.getTime() - 60000) throw erreur(400, 'L’accouchement précède l’admission.');
  if (donnees.mode === 'Césarienne' && !donnees.indicationCesarienne) throw erreur(400, 'Indiquez l’indication de la césarienne.');
  const d = donnees.delivrance ?? {};
  if (d.pertesSangMl != null) d.hemorragie = d.pertesSangMl > acc.HEMORRAGIE_PHYSIOLOGIQUE_MAX_ML ? 'Pathologique' : 'Physiologique';
  const auteur = auteurDe(req.soignant);
  a.accouchement = {
    ...donnees,
    accoucheur: donnees.accoucheur || auteur.nom,
    enregistrePar: a.accouchement?.enregistrePar ?? auteur,
    enregistreLe: a.accouchement?.enregistreLe ?? new Date(),
  };
  if (a.statut === 'En travail') a.statut = 'Post-partum';
  await valider(a);
  await a.save();
  await journaliser(req, { action: 'accouchement.accouchement', patienteId: a.patienteId, ressource: { type: 'accouchement', id: a.numero }, details: { mode: donnees.mode } });
  await synchroniserGrossesse(a, req);
  res.json(await vue(a));
};

/**
 * Module 5 — Nouveau-né : dossier de l'enfant, rattaché à sa mère, avec carnet vaccinal.
 * Formulaire multipart (données JSON dans « donnees », photo du bébé dans « photo ») ; un corps
 * JSON reste accepté pour un mort-né, dont la photo est facultative.
 */
exports.ajouterNouveauNe = async (req, res) => {
  const a = await trouver(req.params.id);
  verifierOuvert(a);
  verifierAccouchee(a);
  let d = req.body;
  if (typeof d?.donnees === 'string') {
    try {
      d = JSON.parse(d.donnees);
    } catch {
      throw erreur(400, 'Données du formulaire invalides.');
    }
  }
  const e = await enfants.creerNaissance(a, objet(d), req);
  await synchroniserGrossesse(a, req);
  res.status(201).json(await enfants.vue(e));
};

/** Module 6 — Surveillance post-partum d'un créneau (mère et nouveau-nés). */
exports.surveillerPostPartum = async (req, res) => {
  const a = await trouver(req.params.id);
  verifierOuvert(a);
  verifierAccouchee(a);
  const creneau = req.body?.creneau;
  if (creneau !== 'Supplémentaire' && !acc.CRENEAUX_POST_PARTUM.some((c) => c.code === creneau)) throw erreur(400, 'Créneau de surveillance inconnu.');
  if (creneau !== 'Supplémentaire' && a.postPartum.surveillances.some((s) => s.creneau === creneau)) {
    throw erreur(409, 'Ce créneau est déjà renseigné : utilisez une surveillance supplémentaire.');
  }
  const le = pasDansLeFutur(instant(req.body.le, 'Heure de la surveillance') ?? new Date(), 'La surveillance');
  const ids = new Set((await Enfant.find({ accouchementId: a._id }).select('_id')).map((e) => e.id));
  const nouveauNes = (Array.isArray(req.body.nouveauNes) ? req.body.nouveauNes : []).map(objet).map((n) => {
    if (!ids.has(String(n.enfantId))) throw erreur(400, 'Nouveau-né inconnu dans ce dossier.');
    return { enfantId: n.enfantId, ...lire(SPEC_POST_PARTUM_NN, n) };
  });
  a.postPartum.surveillances.push({
    creneau, le, mere: lire(SPEC_POST_PARTUM_MERE, req.body.mere), nouveauNes,
    observations: texte(req.body.observations), auteur: auteurDe(req.soignant),
  });
  await valider(a);
  await a.save();
  await journaliser(req, { action: 'accouchement.postpartum', patienteId: a.patienteId, ressource: { type: 'accouchement', id: a.numero }, details: { creneau } });
  res.status(201).json(await vue(a));
};

/** Traitement prévu ou administré (mère ou nouveau-né). */
exports.ajouterTraitement = async (req, res) => {
  const a = await trouver(req.params.id);
  verifierOuvert(a);
  verifierAccouchee(a);
  const d = req.body || {};
  if (!acc.POUR_TRAITEMENT.includes(d.pour)) throw erreur(400, 'Précisez si le traitement est pour la mère ou le nouveau-né.');
  const produit = texte(d.produit, 200);
  if (!produit) throw erreur(400, 'Produit requis.');
  let enfantId = null;
  if (d.pour === 'Nouveau-né') {
    if (!mongoose.isValidObjectId(d.enfantId) || !(await Enfant.exists({ _id: d.enfantId, accouchementId: a._id }))) {
      throw erreur(400, 'Nouveau-né inconnu dans ce dossier.');
    }
    enfantId = d.enfantId;
  }
  const statut = acc.STATUTS_TRAITEMENT.includes(d.statut) ? d.statut : 'Prévu';
  a.postPartum.traitements.push({
    pour: d.pour, enfantId, produit, dose: texte(d.dose, 100), voie: texte(d.voie, 60),
    frequence: texte(d.frequence, 100), duree: texte(d.duree, 100), statut,
    administreLe: statut === 'Administré' ? pasDansLeFutur(instant(d.administreLe, 'Heure d’administration') ?? new Date(), 'L’administration') : null,
    auteur: auteurDe(req.soignant), le: new Date(),
  });
  await valider(a);
  await a.save();
  await journaliser(req, { action: 'accouchement.traitement', patienteId: a.patienteId, ressource: { type: 'accouchement', id: a.numero } });
  res.status(201).json(await vue(a));
};

/** Traitement prévu → administré (heure et soignant conservés). */
exports.administrerTraitement = async (req, res) => {
  const a = await trouver(req.params.id);
  verifierOuvert(a);
  const t = a.postPartum.traitements.id(req.params.traitementId);
  if (!t) throw erreur(404, 'Traitement introuvable.');
  if (t.statut === 'Administré') throw erreur(409, 'Ce traitement est déjà administré.');
  t.statut = 'Administré';
  t.administreLe = pasDansLeFutur(instant(req.body?.administreLe, 'Heure d’administration') ?? new Date(), 'L’administration');
  t.auteur = auteurDe(req.soignant);
  await a.save();
  await journaliser(req, { action: 'accouchement.traitement', patienteId: a.patienteId, ressource: { type: 'accouchement', id: a.numero } });
  res.json(await vue(a));
};

/**
 * Examen de sortie, conseils et mesures préventives. Le rendez-vous de consultation postnatale
 * (CPoN) est créé — ou déplacé — dans l'agenda de la mère.
 */
exports.sortir = async (req, res) => {
  const a = await trouver(req.params.id);
  verifierOuvert(a);
  verifierAccouchee(a);
  const d = req.body || {};
  const auteur = auteurDe(req.soignant);
  const pp = a.postPartum;

  if (d.date !== undefined || d.rdvCpon !== undefined || d.observations !== undefined || !pp.sortie) {
    const date = jour(d.date, 'Date de sortie') ?? pp.sortie?.date;
    if (!date) throw erreur(400, 'Date de sortie requise.');
    if (date < jourKinshasa(a.accouchement.heure)) throw erreur(400, 'La sortie précède l’accouchement.');
    const rdvCpon = d.rdvCpon !== undefined ? instant(d.rdvCpon, 'Date du rendez-vous CPoN') : pp.sortie?.rdvCpon ?? null;
    let rdvCponId = pp.sortie?.rdvCponId ?? null;
    if (rdvCpon && (!pp.sortie?.rdvCpon || rdvCpon.getTime() !== pp.sortie.rdvCpon.getTime())) {
      const existant = rdvCponId && await RendezVous.findOne({ _id: rdvCponId, statut: { $in: STATUTS_ACTIFS } });
      await verifierDoublon(a.patienteId, rdvCpon, existant?._id);
      if (existant) {
        existant.historique.push({ action: 'Reporté', ancienneDate: existant.date, nouvelleDate: rdvCpon, ancienStatut: existant.statut, nouveauStatut: 'Reporté', motif: 'Modifié à la sortie de maternité', par: auteur, le: new Date() });
        existant.date = rdvCpon;
        existant.statut = 'Reporté';
        existant.modifiePar = auteur;
        await existant.save();
      } else {
        const rdv = await RendezVous.create({
          patienteId: a.patienteId, grossesseId: a.grossesseId, date: rdvCpon,
          motif: 'Consultation postnatale (CPoN)', consignes: 'Venir avec le bébé et son carnet de vaccination.',
          etablissementId: a.etablissementId, creePar: auteur,
          historique: [{ action: 'Planifié', nouvelleDate: rdvCpon, nouveauStatut: 'Planifié', motif: 'Sortie de maternité', par: auteur, le: new Date() }],
        });
        rdvCponId = rdv._id;
        await journaliser(req, { action: 'rdv.creation', patienteId: a.patienteId, ressource: { type: 'rendezvous', id: rdv.id } });
      }
    }
    pp.sortie = {
      date, rdvCpon, rdvCponId,
      observations: d.observations !== undefined ? texte(d.observations) : pp.sortie?.observations ?? '',
      examinePar: auteur, le: new Date(),
    };
  }
  if (d.conseils !== undefined) pp.conseils = texte(d.conseils, 5000);
  if (d.mesuresPreventives !== undefined) {
    // Chemin imbriqué (pas un sous-document) : valeurs actuelles lues depuis le dossier entier.
    pp.mesuresPreventives = fusionner(a.toObject().postPartum?.mesuresPreventives ?? {}, lire(SPEC_MESURES, d.mesuresPreventives));
  }
  await valider(a);
  await a.save();
  await journaliser(req, { action: 'accouchement.sortie', patienteId: a.patienteId, ressource: { type: 'accouchement', id: a.numero } });
  res.json(await vue(a));
};

/**
 * Clôture : exige l'accouchement, les nouveau-nés, l'examen de sortie et toutes les mesures
 * préventives renseignées. « BCG / VPO » coché : BCG et VPO 0 sont reportés dans le carnet
 * vaccinal des enfants (à la date de sortie) et leur séance suivante est programmée.
 */
exports.cloturer = async (req, res) => {
  const a = await trouver(req.params.id);
  verifierOuvert(a);
  const nouveauNes = await Enfant.find({ accouchementId: a._id }).sort({ rang: 1 });
  const manquants = manquantsCloture(a, nouveauNes);
  if (manquants.length) throw erreur(400, 'Dossier incomplet : il ne peut pas encore être clôturé.', { manquants });
  if (a.postPartum.sortie.date > jourKinshasa()) throw erreur(400, 'La date de sortie n’est pas encore atteinte.');

  const auteur = auteurDe(req.soignant);
  if (a.postPartum.mesuresPreventives.nouveauNe.bcgVpo === true) {
    for (const e of nouveauNes.filter((x) => x.estSuivi())) {
      const faites = new Set(e.vaccinationsValides().map((v) => v.code));
      const manquantes = ['bcg', 'vpo0'].filter((c) => !faites.has(c));
      if (!manquantes.length) continue;
      for (const code of manquantes) {
        e.vaccinations.push({
          code, date: a.postPartum.sortie.date, etablissementId: a.etablissementId,
          observations: `Administré à la maternité (dossier ${a.numero}).`, administreePar: auteur, le: new Date(),
        });
      }
      await e.save();
      await enfants.marquerSeancesEffectuees(e, auteur);
      await journaliser(req, { action: 'enfant.vaccination', patienteId: e.mereId, ressource: { type: 'enfant', id: e.numero }, details: { codes: manquantes } });
      await enfants.planifierProchaineVaccination(e, auteur, a.etablissementId);
    }
  }
  a.statut = 'Clôturé';
  a.cloture = { par: auteur, le: new Date() };
  await a.save();
  await journaliser(req, { action: 'accouchement.cloture', patienteId: a.patienteId, ressource: { type: 'accouchement', id: a.numero } });
  res.json(await vue(a));
};

/**
 * Suppression définitive d'un dossier d'accouchement (médecins) : le numéro du dossier doit être
 * retapé. Sont supprimés avec lui les dossiers des nouveau-nés qu'il a créés (carnet, vaccinations,
 * croissance) et leurs rendez-vous, ainsi que le rendez-vous CPoN. La grossesse qu'il avait close
 * est rouverte. Le journal d'audit, lui, est conservé (ajout seul), sans donnée clinique.
 */
exports.supprimer = async (req, res) => {
  const a = await trouver(req.params.id);
  if (texte(req.body?.confirmation, 30) !== a.numero) {
    throw erreur(400, `Saisissez le numéro du dossier (${a.numero}) pour confirmer la suppression.`);
  }
  const nouveauNes = await Enfant.find({ accouchementId: a._id }).select('_id photoCle');
  const ids = nouveauNes.map((e) => e._id);
  const rdvCpon = a.postPartum?.sortie?.rdvCponId;
  const [rendezVous, enfantsSupprimes] = await Promise.all([
    RendezVous.deleteMany({ $or: [{ enfantId: { $in: ids } }, ...(rdvCpon ? [{ _id: rdvCpon }] : [])] }),
    Enfant.deleteMany({ _id: { $in: ids } }),
  ]);

  await Promise.all(nouveauNes.filter((e) => e.photoCle).map((e) => supprimerFichier(e.photoCle)
    .catch((err) => console.error(`Fichier ${e.photoCle} non supprimé de R2 :`, err.message))));

  // Grossesse close par ce dossier : rouverte (sauf si une autre grossesse est déjà en cours).
  const g = await Grossesse.findById(a.grossesseId);
  let grossesseRouverte = false;
  if (g?.statut === 'Terminée' && g.issue?.resume === `Dossier d’accouchement ${a.numero}`
      && !(await Grossesse.exists({ patienteId: a.patienteId, statut: 'En cours' }))) {
    g.set('issue', undefined);
    g.statut = 'En cours';
    await g.save();
    await Patiente.updateOne({ _id: a.patienteId, statut: 'Suivi postnatal' }, { statut: 'Suivi prénatal' });
    grossesseRouverte = true;
  }
  await a.deleteOne();
  await journaliser(req, {
    action: 'accouchement.suppression', patienteId: a.patienteId, ressource: { type: 'accouchement', id: a.numero },
    details: { enfants: enfantsSupprimes.deletedCount, rendezVous: rendezVous.deletedCount, grossesseRouverte },
  });
  res.status(204).end();
};
