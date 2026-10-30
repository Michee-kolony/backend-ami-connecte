const mongoose = require('mongoose');
const RendezVous = require('../models/RendezVous');
const Patiente = require('../models/Patiente');
const Grossesse = require('../models/Grossesse');
const Enfant = require('../models/Enfant');
const JournalAudit = require('../models/JournalAudit');
const { auteurDe } = require('../models/commun');
const { journaliser, ACTIONS } = require('../config/audit');
const { verifierVersion } = require('../config/conflits');
const { trouverPatiente, verifierAccesPatiente, idsPatientes } = require('./patientes');
const rappels = require('../config/rappels');

const { STATUTS_ACTIFS, CANAUX_RAPPEL } = RendezVous;
const erreur = (status, message, extra) => Object.assign(new Error(message), { status, ...extra });
const texte = (v, max = 500) => (v == null ? '' : String(v).trim().slice(0, max));

function dateValide(v) {
  const d = new Date(v);
  if (!v || Number.isNaN(d.getTime())) throw erreur(400, 'Date et heure du rendez-vous invalides.');
  return d;
}

/**
 * Un seul rendez-vous attendu par jour pour la patiente, et un seul pour chacun de ses enfants
 * (les rendez-vous de la mère et de son bébé le même jour sont possibles).
 */
async function verifierDoublon(patienteId, date, exclureId, enfantId = null) {
  const jour = new Date(date);
  jour.setUTCHours(0, 0, 0, 0);
  const existant = await RendezVous.findOne({
    patienteId, enfantId: enfantId ?? null, statut: { $in: STATUTS_ACTIFS }, date: { $gte: jour, $lt: new Date(jour.getTime() + 86400000) },
    ...(exclureId ? { _id: { $ne: exclureId } } : {}),
  });
  if (existant) throw erreur(409, enfantId ? 'Cet enfant a déjà un rendez-vous ce jour-là.' : 'Cette patiente a déjà un rendez-vous ce jour-là.');
}
exports.verifierDoublon = verifierDoublon;

/** Agenda : rendez-vous sur une période, avec l'identité minimale de chaque patiente. */
exports.agenda = async (req, res) => {
  const du = req.query.du ? dateValide(req.query.du) : new Date(Date.now() - 30 * 86400000);
  const au = req.query.au ? dateValide(req.query.au) : new Date(Date.now() + 90 * 86400000);
  const filtre = { date: { $gte: du, $lte: au }, patienteId: { $in: await idsPatientes(req) } };
  if (req.query.statut && RendezVous.STATUTS_RDV.includes(req.query.statut)) filtre.statut = req.query.statut;
  const rdvs = await RendezVous.find(filtre).sort({ date: 1 }).limit(500);
  const [patientes, enfants] = await Promise.all([
    Patiente.find({ _id: { $in: [...new Set(rdvs.map((r) => String(r.patienteId)))] } }).select('numero nom postnom prenom'),
    Enfant.find({ _id: { $in: rdvs.map((r) => r.enfantId).filter(Boolean) } }).select('numero nom prenom'),
  ]);
  const parId = new Map(patientes.map((p) => [p.id, p]));
  const enfantsParId = new Map(enfants.map((e) => [e.id, e]));
  res.json(rdvs.map((r) => {
    const p = parId.get(String(r.patienteId));
    const e = r.enfantId && enfantsParId.get(String(r.enfantId));
    return {
      ...r.toJSON(),
      patiente: p ? { id: p.id, numero: p.numero, nom: p.nom, postnom: p.postnom, prenom: p.prenom } : null,
      enfant: e ? { id: e.id, numero: e.numero, nom: e.nom, prenom: e.prenom } : null,
    };
  }));
};

exports.lister = async (req, res) => {
  const p = await trouverPatiente(req, req.params.id);
  res.json(await RendezVous.find({ patienteId: p._id }).sort({ date: -1 }));
};

exports.creer = async (req, res) => {
  const p = await trouverPatiente(req, req.params.id);
  const date = dateValide(req.body?.date);
  await verifierDoublon(p._id, date);
  const grossesse = await Grossesse.findOne({ patienteId: p._id, statut: 'En cours' }).select('_id');
  const auteur = auteurDe(req.soignant);
  const rdv = await RendezVous.create({
    patienteId: p._id, grossesseId: grossesse?._id ?? null, date,
    motif: texte(req.body.motif, 200) || 'Consultation prénatale',
    lieu: texte(req.body.lieu, 200), consignes: texte(req.body.consignes),
    canalRappel: CANAUX_RAPPEL.includes(req.body.canalRappel) ? req.body.canalRappel : 'Aucun',
    etablissementId: req.etablissementId, creePar: auteur,
    historique: [{ action: 'Planifié', nouvelleDate: date, nouveauStatut: 'Planifié', par: auteur, le: new Date() }],
  });
  await journaliser(req, { action: 'rdv.creation', patienteId: p._id, ressource: { type: 'rendezvous', id: rdv.id } });
  res.status(201).json(rdv);
};

/** Transitions autorisées : l'état courant change, l'historique garde l'ancien créneau et le motif. */
const ACTIONS_RDV = {
  confirmer: { statut: 'Confirmé', depuis: ['Planifié', 'Reporté'] },
  reporter: { statut: 'Reporté', depuis: STATUTS_ACTIFS, motifRequis: true },
  effectue: { statut: 'Effectué', depuis: STATUTS_ACTIFS },
  absent: { statut: 'Absent', depuis: STATUTS_ACTIFS },
  annuler: { statut: 'Annulé', depuis: STATUTS_ACTIFS, motifRequis: true },
};

exports.modifier = async (req, res) => {
  const rdv = mongoose.isValidObjectId(req.params.id) && await RendezVous.findById(req.params.id);
  if (!rdv) throw erreur(404, 'Rendez-vous introuvable.');
  await verifierAccesPatiente(req, rdv.patienteId);
  verifierVersion(req, rdv, 'le rendez-vous');
  const regle = ACTIONS_RDV[req.body?.action];
  if (!regle) throw erreur(400, 'Action inconnue.');
  if (!regle.depuis.includes(rdv.statut)) throw erreur(409, `Impossible : ce rendez-vous est « ${rdv.statut} ».`);
  const motif = texte(req.body.motif, 300);
  if (regle.motifRequis && !motif) throw erreur(400, 'Le motif est obligatoire.');

  const auteur = auteurDe(req.soignant);
  const evenement = { action: regle.statut, ancienStatut: rdv.statut, nouveauStatut: regle.statut, motif, par: auteur, le: new Date() };
  if (req.body.action === 'reporter') {
    const nouvelle = dateValide(req.body.date);
    await verifierDoublon(rdv.patienteId, nouvelle, rdv._id, rdv.enfantId);
    evenement.ancienneDate = rdv.date;
    evenement.nouvelleDate = nouvelle;
    rdv.date = nouvelle;
  }
  rdv.historique.push(evenement);
  rdv.statut = regle.statut;
  rdv.modifiePar = auteur;
  await rdv.save();
  await journaliser(req, { action: 'rdv.modification', patienteId: rdv.patienteId, ressource: { type: 'rendezvous', id: rdv.id }, details: { statut: regle.statut } });
  res.json(rdv);
};

/** Délai minimal entre deux rappels envoyés à la demande (évite les doubles clics et les envois répétés). */
const DELAI_RAPPELS_MS = 10 * 60000;

/**
 * Bouton « Envoyer les rappels » de l'agenda (médecins) : chaque patiente ayant un rendez-vous
 * attendu dans les 30 prochains jours reçoit une notification avec la date du prochain.
 */
exports.envoyerRappels = async (req, res) => {
  const dernier = await JournalAudit.findOne({ action: 'rdv.rappels', le: { $gte: new Date(Date.now() - DELAI_RAPPELS_MS) } }).sort({ le: -1 });
  if (dernier) {
    const minutes = Math.ceil((dernier.le.getTime() + DELAI_RAPPELS_MS - Date.now()) / 60000);
    throw erreur(429, `Rappels déjà envoyés par ${dernier.acteur?.nom ?? 'un médecin'} il y a quelques minutes. Réessayez dans ${minutes} min.`);
  }
  // Journalisé avant l'envoi : un second clic pendant l'envoi est refusé.
  await journaliser(req, { action: 'rdv.rappels' });
  const bilan = await rappels.rappelerProchainsRendezVous();
  res.json({ ...bilan, horizonJours: rappels.HORIZON_MANUEL_JOURS });
};

/** Journal d'audit global (médecin chef) : paginé, sans contenu clinique. */
exports.journalGlobal = async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const parPage = Math.min(100, Math.max(1, parseInt(req.query.parPage, 10) || 50));
  const filtre = {};
  if (req.query.resultat === 'refusé') filtre.resultat = 'refusé';
  if (req.query.action && ACTIONS[req.query.action]) filtre.action = req.query.action;
  const [total, entrees] = await Promise.all([
    JournalAudit.countDocuments(filtre),
    JournalAudit.find(filtre).sort({ le: -1 }).skip((page - 1) * parPage).limit(parPage),
  ]);
  const patientes = await Patiente.find({ _id: { $in: entrees.map((e) => e.patienteId).filter(Boolean) } }).select('numero');
  const numeros = new Map(patientes.map((p) => [p.id, p.numero]));
  await journaliser(req, { action: 'journal.lecture' });
  res.json({
    total, page, parPage,
    entrees: entrees.map((e) => ({ ...e.toJSON(), libelle: ACTIONS[e.action] ?? e.action, patienteNumero: numeros.get(String(e.patienteId)) ?? null })),
  });
};
