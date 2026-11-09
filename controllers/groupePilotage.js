// Groupe de pilotage : conversation commune à tous les médecins chefs (actifs) et à tous les
// membres (actifs) du comité de pilotage. Mêmes garanties que les discussions privées : texte
// chiffré au repos, contenu jamais journalisé, taille et débit d'envoi limités, temps réel.
const mongoose = require('mongoose');
const MessageGroupe = require('../models/MessageGroupe');
const Soignant = require('../models/Soignant');
const MembreComite = require('../models/MembreComite');
const Etablissement = require('../models/Etablissement');
const { chiffrer, dechiffrer } = require('../config/chiffrement');
const presence = require('../config/presence');

const GROUPE = 'pilotage';
const ROLE_CHEF = 'Médecin chef de service';
const TAILLE_MAX = 2000;
const PAR_PAGE = 50;
const DEBIT_MAX = 30;
const envoisRecents = new Map();
const erreur = (status, message) => Object.assign(new Error(message), { status });

/** Participant connecté : médecin chef (espace professionnel) ou membre du comité. */
function moi(req) {
  if (req.membreComite) return { id: req.membreComite._id, type: 'comite' };
  return { id: req.soignant._id, type: 'soignant' };
}

/** Accès réservé aux médecins chefs côté personnel (le comité a son propre routeur). */
exports.exigerChef = (req, res, next) => (req.soignant?.role === ROLE_CHEF
  ? next()
  : res.status(403).json({ message: 'Le groupe de pilotage réunit les médecins chefs et le comité de pilotage.' }));

/** Membres du groupe : médecins chefs actifs (avec leur établissement) et membres actifs du comité. */
async function membres() {
  const [chefs, comite] = await Promise.all([
    Soignant.find({ statut: 'Actif', role: ROLE_CHEF }).select('prenom nom photo matricule affectations').lean(),
    MembreComite.find({ statut: 'Actif' }).select('prenom nom photo fonction estPresident').lean(),
  ]);
  const ids = chefs.map((c) => c.affectations?.[0]?.etablissementId).filter((x) => mongoose.isValidObjectId(x));
  const etabs = new Map((await Etablissement.find({ _id: { $in: ids } }).select('nom').lean()).map((e) => [String(e._id), e.nom]));
  return [
    ...comite.map((m) => ({
      id: String(m._id), type: 'comite', prenom: m.prenom, nom: m.nom, photo: m.photo ?? null,
      detail: m.estPresident ? 'Président du comité' : (m.fonction || 'Membre du comité'),
    })),
    ...chefs.map((c) => ({
      id: String(c._id), type: 'soignant', prenom: c.prenom, nom: c.nom, photo: c.photo ?? null,
      detail: `Médecin chef${etabs.get(c.affectations?.[0]?.etablissementId) ? ` · ${etabs.get(c.affectations[0].etablissementId)}` : ''}`,
    })),
  ];
}

function versClient(m) {
  return {
    id: String(m._id), auteurId: String(m.auteurId), auteurType: m.auteurType,
    texte: dechiffrer(m.contenu) ?? '⚠ Message illisible (clé de chiffrement modifiée).',
    envoyeLe: m.createdAt,
    lusPar: (m.lusPar || []).map((l) => ({ id: String(l.id), le: l.le })),
  };
}

/** Résumé du groupe : membres, dernier message et messages non lus du participant connecté. */
exports.resume = async (req, res) => {
  const { id } = moi(req);
  const [liste, dernier, nonLus] = await Promise.all([
    membres(),
    MessageGroupe.findOne({ groupe: GROUPE }).sort({ createdAt: -1 }),
    MessageGroupe.countDocuments({ groupe: GROUPE, auteurId: { $ne: id }, 'lusPar.id': { $ne: id } }),
  ]);
  res.json({ nom: 'Groupe de pilotage', membres: liste, dernierMessage: dernier ? versClient(dernier) : null, nonLus });
};

/** Historique paginé (du plus ancien au plus récent), ?avant=<date ISO> pour remonter. */
exports.messages = async (req, res) => {
  const filtre = { groupe: GROUPE };
  if (req.query.avant) {
    const avant = new Date(req.query.avant);
    if (!Number.isNaN(avant.getTime())) filtre.createdAt = { $lt: avant };
  }
  const page = await MessageGroupe.find(filtre).sort({ createdAt: -1 }).limit(PAR_PAGE + 1);
  res.json({ messages: page.slice(0, PAR_PAGE).reverse().map(versClient), plusAnciens: page.length > PAR_PAGE });
};

/** Envoi : enregistré chiffré, puis remis en temps réel à tout le groupe connecté. */
exports.envoyer = async (req, res) => {
  const { id, type } = moi(req);
  const texte = typeof req.body?.texte === 'string' ? req.body.texte.replace(/\r\n/g, '\n').trim() : '';
  if (!texte) throw erreur(400, 'Message vide.');
  if (texte.length > TAILLE_MAX) throw erreur(400, `Message trop long (${TAILLE_MAX} caractères au maximum).`);
  const maintenant = Date.now();
  const recents = (envoisRecents.get(String(id)) || []).filter((t) => maintenant - t < 60000);
  if (recents.length >= DEBIT_MAX) throw erreur(429, 'Trop de messages envoyés : patientez quelques secondes.');
  recents.push(maintenant);
  envoisRecents.set(String(id), recents);

  const m = await MessageGroupe.create({ groupe: GROUPE, auteurId: id, auteurType: type, contenu: chiffrer(texte), lusPar: [{ id, le: new Date() }] });
  const message = versClient(m);
  presence.emettrePilotage('groupe:message', message);
  res.status(201).json(message);
};

/** Accusé de lecture de tous les messages reçus dans le groupe. */
exports.marquerLu = async (req, res) => {
  const { id } = moi(req);
  const le = new Date();
  const r = await MessageGroupe.updateMany(
    { groupe: GROUPE, auteurId: { $ne: id }, 'lusPar.id': { $ne: id } },
    { $push: { lusPar: { id, le } } },
  );
  if (r.modifiedCount) presence.emettrePilotage('groupe:lu', { id: String(id), le });
  res.json({ lus: r.modifiedCount });
};
