// Relance communautaire, côté personnel (espace administrateur) : tâches, supervision,
// confirmation des prestations, alertes, conflits de synchronisation.
// Droits (section 14, moindre privilège) :
//   - superviseurs et responsables : tâches nominatives de leur structure (toutes si aucune
//     structure n'est choisie à la connexion), attribution, clôture, contrôle ;
//   - autres soignants (prestataires) : seulement les personnes orientées vers leur structure,
//     pour confirmer la prestation.
const mongoose = require('mongoose');
const TacheRelance = require('../models/TacheRelance');
const AlerteRelance = require('../models/AlerteRelance');
const Reco = require('../models/Reco');
const Patiente = require('../models/Patiente');
const Enfant = require('../models/Enfant');
const Etablissement = require('../models/Etablissement');
const { auteurDe } = require('../models/commun');
const { journaliser } = require('../config/audit');
const moteur = require('../config/moteurRelance');
const r = require('../config/relance');
const { erreur, texte, objet } = require('./saisie');

/** Échéance d'une tâche rouverte. */
const REPRISE_JOURS = 3;

const estSuperviseur = (req) => r.ROLES_SUPERVISION.includes(req.soignant.role);

/** Filtre de territoire : la structure choisie à la connexion (aucune : toutes). */
function filtreTerritoire(req) {
  return req.etablissementId ? { etablissementId: req.etablissementId } : {};
}

/** Tâches visibles par le soignant connecté. */
function filtreVisibilite(req) {
  if (estSuperviseur(req)) return filtreTerritoire(req);
  const etab = req.etablissementId;
  return {
    statut: 'Orientée',
    ...(etab ? { $or: [{ 'orientation.etablissementId': etab }, { etablissementId: etab, 'orientation.etablissementId': null }] } : {}),
  };
}

async function trouverTache(req, numero) {
  const t = await TacheRelance.findOne({ numero: String(numero), ...filtreVisibilite(req) });
  if (!t) throw erreur(404, 'Tâche introuvable.');
  return t;
}

/** Superviseurs seulement (contrôle serveur, journalisé en cas de refus). */
async function exigerSupervision(req) {
  if (estSuperviseur(req)) return;
  await journaliser(req, { action: 'acces.refuse', resultat: 'refusé', ressource: { type: 'relance', id: null }, details: { role: req.soignant.role, chemin: req.path } });
  throw erreur(403, 'Action réservée aux superviseurs communautaires et responsables de structure.');
}

const nomComplet = (x) => [x?.prenom, x?.nom, x?.postnom].filter(Boolean).join(' ');
const telephoneMasque = (t) => {
  const c = String(t || '').replace(/\D/g, '');
  return c.length >= 4 ? `•••• ${c.slice(-4)}` : '';
};

/** Personnes, RECO et structures des tâches (une requête par collection). */
async function contexte(taches) {
  const ids = (champ) => [...new Set(taches.map((t) => t[champ]).filter(Boolean).map(String))];
  const [patientes, enfants, recos] = await Promise.all([
    Patiente.find({ _id: { $in: ids('patienteId') } }).select('numero prenom nom postnom telephone adresse'),
    Enfant.find({ _id: { $in: ids('enfantId') } }).select('numero prenom nom sexe dateNaissance'),
    Reco.find({ _id: { $in: ids('recoId') } }).select('matricule prenom nom telephone statut photo'),
  ]);
  const etabIds = [...new Set(taches.flatMap((t) => [t.etablissementId, t.orientation?.etablissementId]).filter((id) => mongoose.isValidObjectId(id)))];
  const structures = await Etablissement.find({ _id: { $in: etabIds } }).select('nom');
  const carte = (liste) => new Map(liste.map((x) => [x.id, x]));
  return { patientes: carte(patientes), enfants: carte(enfants), recos: carte(recos), structures: carte(structures) };
}

function vueListe(t, ctx, maintenant = new Date()) {
  const p = t.patienteId ? ctx.patientes.get(String(t.patienteId)) : null;
  const e = t.enfantId ? ctx.enfants.get(String(t.enfantId)) : null;
  const reco = t.recoId ? ctx.recos.get(String(t.recoId)) : null;
  return {
    numero: t.numero, statut: t.statut, priorite: t.priorite, domaine: t.domaine, parcoursCode: t.parcoursCode, source: t.source,
    motif: t.motifs[0]?.libelle ?? '', motifsLies: Math.max(0, t.motifs.length - 1),
    personne: t.personneType === 'Déclarée'
      ? { type: 'Déclarée', nom: t.declaree?.nom ?? '', quartier: t.declaree?.quartier ?? '' }
      : {
        type: t.personneType, patienteId: p?.id ?? null, numero: p?.numero ?? '', nom: nomComplet(p),
        enfant: e ? { id: e.id, numero: e.numero, prenom: e.prenom || 'Enfant', dateNaissance: e.dateNaissance } : null,
        quartier: p?.adresse?.quartier ?? '', telephone: telephoneMasque(p?.telephone),
      },
    etablissementId: t.etablissementId, structure: ctx.structures.get(t.etablissementId)?.nom ?? '', aireSante: t.aireSante, zone: t.zone,
    reco: reco ? { id: reco.id, matricule: reco.matricule, nom: `${reco.prenom} ${reco.nom}`, statut: reco.statut, photo: reco.photo } : null,
    echeance: t.echeance, enRetard: t.enRetard(maintenant), dateEvenement: t.dateEvenement,
    tentativesEchouees: t.tentativesEchouees, conflitsEnAttente: t.conflits.filter((c) => !c.resolu).length,
    orientation: t.orientation ? { le: t.orientation.le, structure: t.orientation.structure, priorite: t.orientation.priorite } : null,
    creeLe: t.createdAt, statutLe: t.statutLe,
  };
}

function vueDetail(t, ctx) {
  const p = t.patienteId ? ctx.patientes.get(String(t.patienteId)) : null;
  return {
    ...vueListe(t, ctx),
    personne: {
      ...vueListe(t, ctx).personne,
      ...(p ? { commune: p.adresse?.commune ?? '', avenue: p.adresse?.avenue ?? '', repere: p.adresse?.repere ?? '' } : {}),
      ...(t.declaree ? { repere: t.declaree.repere, telephone: t.declaree.telephone } : {}),
    },
    parcoursVersion: t.parcoursVersion, motifs: t.motifs, parametres: t.parametres,
    actions: t.actions, visites: t.visites, contactEtabliLe: t.contactEtabliLe,
    orientation: t.orientation ?? null, confirmation: t.confirmation ?? null, resolution: t.resolution ?? null,
    doublonDe: t.doublonDe, escalade: t.escalade ?? null, controles: t.controles, conflits: t.conflits,
    historique: t.historique, reattributions: t.reattributions, attribueeLe: t.attribueeLe,
  };
}

// --- Liste et détail ----------------------------------------------------------------------

exports.lister = async (req, res) => {
  const q = req.query;
  const filtre = { ...filtreVisibilite(req) };
  const choix = (v, liste) => (liste.includes(v) ? v : undefined);
  if (q.statut === 'ouvertes') filtre.ouverte = true;
  else if (q.statut === 'supervision') filtre.statut = { $in: r.STATUTS_SUPERVISION };
  else if (choix(q.statut, r.STATUTS) && !filtre.statut) filtre.statut = q.statut;
  if (choix(q.domaine, r.DOMAINES)) filtre.domaine = q.domaine;
  if (choix(q.priorite, r.PRIORITES)) filtre.priorite = q.priorite;
  if (q.parcours) filtre.parcoursCode = q.parcours === 'aucun' ? null : texte(q.parcours, 12);
  if (q.reco === 'aucun') filtre.recoId = null;
  else if (mongoose.isValidObjectId(q.reco)) filtre.recoId = q.reco;
  if (q.aire) filtre.aireSante = texte(q.aire, 120);
  if (q.retard === '1') Object.assign(filtre, { ouverte: true, echeance: { $lt: new Date() } });
  if (q.conflits === '1') filtre['conflits.resolu'] = false;
  if (q.recherche) filtre.numero = new RegExp(`^${texte(q.recherche, 20).replace(/[^A-Za-z0-9-]/g, '')}`, 'i');
  const limite = Math.min(Number(q.limite) || 100, 300);
  const [taches, total] = await Promise.all([
    TacheRelance.find(filtre).sort({ ouverte: -1, echeance: 1 }).limit(limite),
    TacheRelance.countDocuments(filtre),
  ]);
  const ctx = await contexte(taches);
  const maintenant = new Date();
  res.json({ total, taches: taches.map((t) => vueListe(t, ctx, maintenant)), nominatif: estSuperviseur(req) });
};

exports.obtenir = async (req, res) => {
  const t = await trouverTache(req, req.params.numero);
  await journaliser(req, { action: 'relance.tache.lecture', patienteId: t.patienteId, ressource: { type: 'relance', id: t.numero } });
  res.json(vueDetail(t, await contexte([t])));
};

async function repondre(res, t) {
  res.json(vueDetail(t, await contexte([t])));
}

// --- Supervision --------------------------------------------------------------------------

exports.attribuer = async (req, res) => {
  await exigerSupervision(req);
  const t = await trouverTache(req, req.params.numero);
  if (!t.estOuverte()) throw erreur(409, `Tâche « ${t.statut} » : rouvrez-la d’abord.`);
  const d = objet(req.body);
  const reco = mongoose.isValidObjectId(d.recoId) ? await Reco.findById(d.recoId) : null;
  if (!reco || reco.statut !== 'Actif') throw erreur(400, 'Choisissez un RECO actif.');
  if (t.etablissementId && reco.etablissementId !== t.etablissementId) throw erreur(400, 'Ce RECO n’est pas rattaché à la structure de la tâche.');
  const motif = texte(d.motif, 300);
  const reattribution = t.recoId && String(t.recoId) !== reco.id;
  if (reattribution && !motif) throw erreur(400, 'Indiquez le motif de la réattribution.');
  const par = auteurDe(req.soignant);
  // Reprise d'une personne non retrouvée : nouveau cycle de tentatives.
  if (t.statut === 'Non retrouvée') t.tentativesEchouees = 0;
  moteur.attribuer(t, reco, par, { motif });
  // Reprise après supervision (non retrouvée, refus, escalade) : nouvelle échéance possible.
  if (d.echeance) {
    const echeance = new Date(d.echeance);
    if (Number.isNaN(echeance.getTime()) || echeance < new Date()) throw erreur(400, 'Nouvelle échéance invalide.');
    t.echeance = echeance;
    t.alertes.retard = null;
    t.alertes.echeanceProche = null;
  }
  if (r.STATUTS_SUPERVISION.includes(t.statut)) t.changerStatut('Attribuée', par, { action: 'Reprise par le RECO', motif });
  await t.save();
  await moteur.alerter('attribution', { recoId: reco._id, taches: [t.numero] });
  await journaliser(req, {
    action: 'relance.tache.attribution', patienteId: t.patienteId, ressource: { type: 'relance', id: t.numero },
    details: { reco: reco.matricule, reattribution: !!reattribution },
  });
  await repondre(res, t);
};

/**
 * Confirmation de la prestation par la structure (prestataire) : seule preuve de la
 * réintégration avec la prestation enregistrée dans le dossier de soins.
 */
exports.confirmer = async (req, res) => {
  const t = await trouverTache(req, req.params.numero);
  if (!t.estOuverte()) throw erreur(409, `Tâche déjà « ${t.statut} ».`);
  const d = objet(req.body);
  const reference = texte(d.reference, 200);
  if (!reference) throw erreur(400, 'Indiquez la référence de la prestation (consultation, dose, registre…).');
  moteur.confirmer(t, { source: 'Structure', type: texte(d.type, 120) || 'Prestation confirmée par la structure', reference, par: auteurDe(req.soignant) });
  await t.save();
  await journaliser(req, { action: 'relance.tache.confirmation', patienteId: t.patienteId, ressource: { type: 'relance', id: t.numero } });
  await repondre(res, t);
};

exports.cloturer = async (req, res) => {
  await exigerSupervision(req);
  const t = await trouverTache(req, req.params.numero);
  if (!t.estOuverte()) throw erreur(409, `Tâche déjà « ${t.statut} ».`);
  const d = objet(req.body);
  const motif = texte(d.motif, 500);
  if (!motif) throw erreur(400, 'Le motif de clôture est obligatoire.');
  const par = auteurDe(req.soignant);
  const exceptionnelle = !r.STATUTS_SUPERVISION.includes(t.statut);
  if (d.statut === 'Doublon annulé') {
    const gardee = await TacheRelance.findOne({ numero: texte(d.doublonDe, 20), ...filtreTerritoire(req) });
    if (!gardee || gardee.numero === t.numero) throw erreur(400, 'Indiquez la tâche conservée.');
    t.doublonDe = gardee.numero;
    t.resolution = { statut: 'Doublon annulé', resultat: 'Doublon', motif, exceptionnelle, le: new Date(), par };
    t.changerStatut('Doublon annulé', par, { action: 'Doublon annulé', motif, details: { conservee: gardee.numero } });
    gardee.noter('Doublon relié', par, { details: { doublon: t.numero } });
    await gardee.save();
  } else {
    const resultats = r.RESULTATS_CLOTURE.filter((x) => !['Réintégration confirmée', 'Doublon'].includes(x));
    if (!resultats.includes(d.resultat)) throw erreur(400, 'Choisissez le résultat de la clôture.');
    t.resolution = { statut: 'Clôturée sans réintégration', resultat: d.resultat, motif, exceptionnelle, le: new Date(), par };
    t.changerStatut('Clôturée sans réintégration', par, { action: exceptionnelle ? 'Clôture exceptionnelle' : 'Clôture', motif, details: { resultat: d.resultat } });
  }
  await t.save();
  await journaliser(req, {
    action: 'relance.tache.cloture', patienteId: t.patienteId, ressource: { type: 'relance', id: t.numero },
    details: { statut: t.statut, resultat: t.resolution.resultat, exceptionnelle },
  });
  await repondre(res, t);
};

/** Réouverture : jamais d'une réintégration confirmée (la confirmation clinique n'est pas effacée). */
exports.rouvrir = async (req, res) => {
  await exigerSupervision(req);
  const t = await trouverTache(req, req.params.numero);
  if (t.estOuverte()) throw erreur(409, 'Cette tâche est déjà ouverte.');
  if (t.statut === 'Réintégration confirmée') throw erreur(409, 'Une réintégration confirmée ne peut pas être rouverte : créez un nouveau suivi si nécessaire.');
  const motif = texte(req.body?.motif, 500);
  if (!motif) throw erreur(400, 'Indiquez le motif de la réouverture.');
  if (await TacheRelance.exists({ cle: t.cle, ouverte: true })) throw erreur(409, 'Une autre tâche est déjà ouverte pour cette personne dans ce parcours.');
  const par = auteurDe(req.soignant);
  t.changerStatut(t.recoId ? 'Attribuée' : 'Nouvelle', par, { action: 'Réouverture', motif, details: { resolutionPrecedente: t.resolution?.resultat ?? null } });
  t.resolution = undefined;
  t.doublonDe = null;
  t.echeance = new Date(Date.now() + REPRISE_JOURS * r.JOUR);
  t.alertes = {};
  await t.save();
  await journaliser(req, { action: 'relance.tache.reouverture', patienteId: t.patienteId, ressource: { type: 'relance', id: t.numero } });
  await repondre(res, t);
};

exports.escalader = async (req, res) => {
  await exigerSupervision(req);
  const t = await trouverTache(req, req.params.numero);
  if (!t.estOuverte()) throw erreur(409, `Tâche déjà « ${t.statut} ».`);
  const motif = texte(req.body?.motif, 500);
  if (!motif) throw erreur(400, 'Indiquez le motif de l’escalade.');
  const par = auteurDe(req.soignant);
  t.escalade = { le: new Date(), motif, vers: texte(req.body?.vers, 120) || 'Professionnel habilité', par };
  t.changerStatut('Escaladée', par, { action: 'Escalade', motif });
  await t.save();
  await journaliser(req, { action: 'relance.tache.escalade', patienteId: t.patienteId, ressource: { type: 'relance', id: t.numero } });
  await repondre(res, t);
};

/** Contrôle qualité d'un échantillon de tâches (section 5, étape 10). */
exports.controler = async (req, res) => {
  await exigerSupervision(req);
  const t = await trouverTache(req, req.params.numero);
  const d = objet(req.body);
  if (typeof d.conforme !== 'boolean') throw erreur(400, 'Indiquez si la tâche est conforme.');
  const observation = texte(d.observation, 500);
  if (!d.conforme && !observation) throw erreur(400, 'Décrivez l’anomalie constatée.');
  const par = auteurDe(req.soignant);
  t.controles.push({ le: new Date(), conforme: d.conforme, observation, par });
  t.noter(d.conforme ? 'Contrôle : conforme' : 'Contrôle : non conforme', par, { motif: observation });
  await t.save();
  await journaliser(req, { action: 'relance.tache.controle', patienteId: t.patienteId, ressource: { type: 'relance', id: t.numero }, details: { conforme: d.conforme } });
  await repondre(res, t);
};

/**
 * Personne signalée par un RECO : rattachement au dossier AMI (patiente ou enfant). Si une
 * tâche est déjà ouverte pour cette personne, le signalement y est relié et annulé comme doublon.
 */
exports.identifier = async (req, res) => {
  await exigerSupervision(req);
  const t = await trouverTache(req, req.params.numero);
  if (t.personneType !== 'Déclarée' || !t.estOuverte()) throw erreur(409, 'Seul un signalement ouvert peut être rattaché à un dossier.');
  const d = objet(req.body);
  const enfant = mongoose.isValidObjectId(d.enfantId) ? await Enfant.findById(d.enfantId) : null;
  const patiente = enfant ? await Patiente.findById(enfant.mereId) : mongoose.isValidObjectId(d.patienteId) ? await Patiente.findById(d.patienteId) : null;
  if (!patiente) throw erreur(400, 'Dossier introuvable.');
  const par = auteurDe(req.soignant);
  const personneType = enfant ? 'Enfant' : 'Patiente';
  const cle = `${t.parcoursCode ?? 'SIGNALEMENT'}:${personneType}:${(enfant ?? patiente).id}`;
  const existante = await TacheRelance.findOne({ cle, ouverte: true });
  Object.assign(t, { personneType, patienteId: patiente._id, enfantId: enfant?._id ?? null, aireSante: patiente.adresse?.aireSante || t.aireSante, zone: patiente.adresse?.quartier || t.zone });
  t.noter('Personne identifiée', par, { details: { dossier: (enfant ?? patiente).numero } });
  if (existante) {
    t.doublonDe = existante.numero;
    t.resolution = { statut: 'Doublon annulé', resultat: 'Doublon', motif: `Personne déjà suivie (${existante.numero})`, le: new Date(), par };
    t.changerStatut('Doublon annulé', par, { action: 'Doublon annulé', motif: `Relié à ${existante.numero}` });
    existante.motifs.push(...t.motifs);
    existante.clesMotifs.push(...t.clesMotifs);
    existante.noter('Signalement relié', par, { details: { signalement: t.numero } });
    await existante.save();
  } else {
    t.cle = cle;
  }
  await t.save();
  await journaliser(req, { action: 'relance.tache.identification', patienteId: patiente._id, ressource: { type: 'relance', id: t.numero } });
  await repondre(res, t);
};

/** Arbitrage d'un conflit de synchronisation : la décision est tracée, rien n'est écrasé. */
exports.resoudreConflit = async (req, res) => {
  await exigerSupervision(req);
  const t = await trouverTache(req, req.params.numero);
  const conflit = t.conflits.id(req.params.conflitId);
  if (!conflit) throw erreur(404, 'Conflit introuvable.');
  if (conflit.resolu) throw erreur(409, 'Ce conflit est déjà arbitré.');
  const decision = texte(req.body?.decision, 500);
  if (!decision) throw erreur(400, 'Indiquez la décision prise.');
  const par = auteurDe(req.soignant);
  Object.assign(conflit, { resolu: true, decision, resoluPar: par, resoluLe: new Date() });
  t.noter('Conflit arbitré', par, { motif: decision, details: { operationId: conflit.operationId } });
  await t.save();
  await journaliser(req, { action: 'relance.conflit', patienteId: t.patienteId, ressource: { type: 'relance', id: t.numero } });
  await repondre(res, t);
};

exports.lancerDetection = async (req, res) => {
  await exigerSupervision(req);
  const bilan = await moteur.tourner();
  await journaliser(req, { action: 'relance.detection', details: { creees: bilan.creees, reliees: bilan.reliees, confirmees: bilan.confirmees } });
  res.json(bilan);
};

// --- Alertes ------------------------------------------------------------------------------

/** Alertes de supervision et de structure du territoire (les prestataires : celles de leur structure). */
function filtreAlertes(req) {
  const destinataires = estSuperviseur(req) ? ['supervision', 'structure'] : ['structure'];
  return { destinataire: { $in: destinataires }, ...(req.etablissementId ? { etablissementId: req.etablissementId } : {}) };
}

exports.alertes = async (req, res) => {
  const filtre = filtreAlertes(req);
  if (req.query.ouvertes === '1') filtre.ouverte = true;
  const alertes = await AlerteRelance.find(filtre).sort({ ouverte: -1, derniereLe: -1 }).limit(100);
  res.json(alertes.map((a) => ({ ...a.toJSON(), libelle: r.ALERTES[a.type].libelle })));
};

exports.accuserAlerte = async (req, res) => {
  const a = mongoose.isValidObjectId(req.params.id) ? await AlerteRelance.findOne({ _id: req.params.id, ...filtreAlertes(req) }) : null;
  if (!a) throw erreur(404, 'Alerte introuvable.');
  if (a.ouverte) {
    Object.assign(a, { ouverte: false, accuseLe: new Date(), accusePar: auteurDe(req.soignant) });
    await a.save();
    await journaliser(req, { action: 'relance.alerte.accuse', ressource: { type: 'alerte', id: a.id }, details: { type: a.type } });
  }
  res.json({ ...a.toJSON(), libelle: r.ALERTES[a.type].libelle });
};

/** Référentiel du module (listes de choix de l'interface). */
exports.referentiel = async (req, res) => {
  res.json({
    statuts: r.STATUTS, statutsFinaux: r.STATUTS_FINAUX, statutsSupervision: r.STATUTS_SUPERVISION, domaines: r.DOMAINES,
    priorites: r.PRIORITES, resultatsCloture: r.RESULTATS_CLOTURE.filter((x) => !['Réintégration confirmée', 'Doublon'].includes(x)),
    codesParcours: r.CODES_PARCOURS, alertes: Object.fromEntries(Object.entries(r.ALERTES).map(([k, v]) => [k, v.libelle])),
    droits: { supervision: estSuperviseur(req), parametrage: r.ROLES_PARAMETRAGE.includes(req.soignant.role), responsable: r.ROLES_RESPONSABLE.includes(req.soignant.role) },
  });
};

module.exports.estSuperviseur = estSuperviseur;
module.exports.filtreTerritoire = filtreTerritoire;
module.exports.exigerSupervision = exigerSupervision;
