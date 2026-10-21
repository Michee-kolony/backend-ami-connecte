const mongoose = require('mongoose');
const RendezVous = require('../models/RendezVous');
const Patiente = require('../models/Patiente');
const Grossesse = require('../models/Grossesse');
const JournalAudit = require('../models/JournalAudit');
const { auteurDe } = require('../models/commun');
const { journaliser, ACTIONS } = require('../config/audit');
const { trouverPatiente } = require('./patientes');

const { STATUTS_ACTIFS, CANAUX_RAPPEL } = RendezVous;
const erreur = (status, message, extra) => Object.assign(new Error(message), { status, ...extra });
const texte = (v, max = 500) => (v == null ? '' : String(v).trim().slice(0, max));

function dateValide(v) {
  const d = new Date(v);
  if (!v || Number.isNaN(d.getTime())) throw erreur(400, 'Date et heure du rendez-vous invalides.');
  return d;
}

/** Un seul rendez-vous attendu par patiente et par jour (évite les doublons). */
async function verifierDoublon(patienteId, date, exclureId) {
  const jour = new Date(date);
  jour.setUTCHours(0, 0, 0, 0);
  const existant = await RendezVous.findOne({
    patienteId, statut: { $in: STATUTS_ACTIFS }, date: { $gte: jour, $lt: new Date(jour.getTime() + 86400000) },
    ...(exclureId ? { _id: { $ne: exclureId } } : {}),
  });
  if (existant) throw erreur(409, 'Cette patiente a déjà un rendez-vous ce jour-là.');
}

/** Agenda : rendez-vous sur une période, avec l'identité minimale de chaque patiente. */
exports.agenda = async (req, res) => {
  const du = req.query.du ? dateValide(req.query.du) : new Date(Date.now() - 30 * 86400000);
  const au = req.query.au ? dateValide(req.query.au) : new Date(Date.now() + 90 * 86400000);
  const filtre = { date: { $gte: du, $lte: au } };
  if (req.query.statut && RendezVous.STATUTS_RDV.includes(req.query.statut)) filtre.statut = req.query.statut;
  const rdvs = await RendezVous.find(filtre).sort({ date: 1 }).limit(500);
  const patientes = await Patiente.find({ _id: { $in: [...new Set(rdvs.map((r) => String(r.patienteId)))] } })
    .select('numero nom postnom prenom');
  const parId = new Map(patientes.map((p) => [p.id, p]));
  res.json(rdvs.map((r) => {
    const p = parId.get(String(r.patienteId));
    return {
      ...r.toJSON(),
      patiente: p ? { id: p.id, numero: p.numero, nom: p.nom, postnom: p.postnom, prenom: p.prenom } : null,
    };
  }));
};

exports.lister = async (req, res) => {
  const p = await trouverPatiente(req.params.id);
  res.json(await RendezVous.find({ patienteId: p._id }).sort({ date: -1 }));
};

exports.creer = async (req, res) => {
  const p = await trouverPatiente(req.params.id);
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
  const regle = ACTIONS_RDV[req.body?.action];
  if (!regle) throw erreur(400, 'Action inconnue.');
  if (!regle.depuis.includes(rdv.statut)) throw erreur(409, `Impossible : ce rendez-vous est « ${rdv.statut} ».`);
  const motif = texte(req.body.motif, 300);
  if (regle.motifRequis && !motif) throw erreur(400, 'Le motif est obligatoire.');

  const auteur = auteurDe(req.soignant);
  const evenement = { action: regle.statut, ancienStatut: rdv.statut, nouveauStatut: regle.statut, motif, par: auteur, le: new Date() };
  if (req.body.action === 'reporter') {
    const nouvelle = dateValide(req.body.date);
    await verifierDoublon(rdv.patienteId, nouvelle, rdv._id);
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
