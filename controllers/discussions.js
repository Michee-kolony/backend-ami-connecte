// Discussions privées entre soignants (médecins et infirmier·ères), en temps réel.
// Sécurité : participants seulement (vérifié à chaque requête), texte chiffré au repos,
// contenu jamais journalisé, taille et débit d'envoi limités.
const mongoose = require('mongoose');
const Discussion = require('../models/Discussion');
const MessageDiscussion = require('../models/MessageDiscussion');
const Soignant = require('../models/Soignant');
const { chiffrer, dechiffrer } = require('../config/chiffrement');
const presence = require('../config/presence');

const TAILLE_MAX = 2000;
const PAR_PAGE = 50;
const DEBIT_MAX = 30; // messages par minute et par soignant
const envoisRecents = new Map(); // soignantId → horodatages des envois de la dernière minute

const erreur = (status, message) => Object.assign(new Error(message), { status });
const CHAMPS_PROFIL = 'prenom nom role photo matricule statut';

function profil(s) {
  return s ? { id: String(s._id), prenom: s.prenom, nom: s.nom, role: s.role, photo: s.photo ?? null, matricule: s.matricule, statut: s.statut } : null;
}

/** Message tel qu'envoyé au client (texte déchiffré, accusé de lecture de l'autre participant). */
function versClient(m) {
  return {
    id: String(m._id),
    discussionId: String(m.discussionId),
    auteurId: String(m.auteurId),
    texte: dechiffrer(m.contenu) ?? '⚠ Message illisible (clé de chiffrement modifiée).',
    envoyeLe: m.createdAt,
    lusPar: (m.lusPar || []).map((l) => ({ soignantId: String(l.soignantId), le: l.le })),
  };
}

/** Discussion dont le soignant connecté est participant (sinon 404, sans révéler son existence). */
async function discussionDe(req) {
  const d = mongoose.isValidObjectId(req.params.id) && await Discussion.findById(req.params.id);
  if (!d || !d.aPourParticipant(req.soignant._id)) throw erreur(404, 'Discussion introuvable.');
  return d;
}

/** Mes discussions : interlocuteur, dernier message, nombre de messages non lus. */
exports.lister = async (req, res) => {
  const moi = req.soignant._id;
  const discussions = await Discussion.find({ participants: moi }).sort({ dernierMessageLe: -1, updatedAt: -1 })
    .populate('participants', CHAMPS_PROFIL);
  const resultats = await Promise.all(discussions.map(async (d) => {
    const [dernier, nonLus] = await Promise.all([
      MessageDiscussion.findOne({ discussionId: d._id }).sort({ createdAt: -1 }),
      MessageDiscussion.countDocuments({ discussionId: d._id, auteurId: { $ne: moi }, 'lusPar.soignantId': { $ne: moi } }),
    ]);
    return {
      id: d.id,
      interlocuteur: profil(d.participants.find((p) => !p._id.equals(moi))),
      dernierMessage: dernier ? versClient(dernier) : null,
      nonLus,
      dernierMessageLe: d.dernierMessageLe,
    };
  }));
  res.json(resultats);
};

/** Ouvre (ou crée) la discussion avec un autre soignant actif. */
exports.ouvrir = async (req, res) => {
  const autreId = String(req.body?.soignantId || '');
  if (!mongoose.isValidObjectId(autreId)) throw erreur(400, 'Soignant invalide.');
  if (autreId === req.soignant.id) throw erreur(400, 'Vous ne pouvez pas discuter avec vous-même.');
  const autre = await Soignant.findById(autreId).select(CHAMPS_PROFIL);
  if (!autre || autre.statut !== 'Actif') throw erreur(404, 'Soignant introuvable ou suspendu.');
  const cle = Discussion.cleDe(req.soignant._id, autre._id);
  let d = await Discussion.findOne({ cle });
  if (!d) {
    try {
      d = await Discussion.create({ participants: [req.soignant._id, autre._id], cle });
    } catch (err) {
      if (err.code !== 11000) throw err;
      d = await Discussion.findOne({ cle }); // créée au même instant par l'autre soignant
    }
  }
  res.status(201).json({ id: d.id, interlocuteur: profil(autre), dernierMessage: null, nonLus: 0, dernierMessageLe: d.dernierMessageLe });
};

/** Historique paginé (du plus ancien au plus récent), ?avant=<date ISO> pour remonter. */
exports.messages = async (req, res) => {
  const d = await discussionDe(req);
  const filtre = { discussionId: d._id };
  if (req.query.avant) {
    const avant = new Date(req.query.avant);
    if (!Number.isNaN(avant.getTime())) filtre.createdAt = { $lt: avant };
  }
  const page = await MessageDiscussion.find(filtre).sort({ createdAt: -1 }).limit(PAR_PAGE + 1);
  res.json({ messages: page.slice(0, PAR_PAGE).reverse().map(versClient), plusAnciens: page.length > PAR_PAGE });
};

/** Limite de débit en mémoire (par soignant, fenêtre glissante d'une minute). */
function verifierDebit(soignantId) {
  const maintenant = Date.now();
  const recents = (envoisRecents.get(soignantId) || []).filter((t) => maintenant - t < 60000);
  if (recents.length >= DEBIT_MAX) throw erreur(429, 'Trop de messages envoyés : patientez quelques secondes.');
  recents.push(maintenant);
  envoisRecents.set(soignantId, recents);
}

/** Envoi : enregistré chiffré, puis remis en temps réel aux deux participants (tous leurs onglets). */
exports.envoyer = async (req, res) => {
  const d = await discussionDe(req);
  const texte = typeof req.body?.texte === 'string' ? req.body.texte.replace(/\r\n/g, '\n').trim() : '';
  if (!texte) throw erreur(400, 'Message vide.');
  if (texte.length > TAILLE_MAX) throw erreur(400, `Message trop long (${TAILLE_MAX} caractères au maximum).`);
  const autre = d.participants.find((p) => !p.equals(req.soignant._id));
  if (!(await Soignant.exists({ _id: autre, statut: 'Actif' }))) throw erreur(409, 'Ce soignant n’a plus d’accès actif.');
  verifierDebit(req.soignant.id);

  const m = await MessageDiscussion.create({
    discussionId: d._id, auteurId: req.soignant._id, contenu: chiffrer(texte),
    lusPar: [{ soignantId: req.soignant._id, le: new Date() }],
  });
  d.dernierMessageLe = m.createdAt;
  await d.save();
  const message = versClient(m);
  for (const p of d.participants) presence.emettre(String(p), 'discussion:message', message);
  res.status(201).json(message);
};

/** Accusé de lecture de tous les messages reçus dans la discussion. */
exports.marquerLu = async (req, res) => {
  const d = await discussionDe(req);
  const le = new Date();
  const r = await MessageDiscussion.updateMany(
    { discussionId: d._id, auteurId: { $ne: req.soignant._id }, 'lusPar.soignantId': { $ne: req.soignant._id } },
    { $push: { lusPar: { soignantId: req.soignant._id, le } } },
  );
  if (r.modifiedCount) {
    for (const p of d.participants) presence.emettre(String(p), 'discussion:lu', { discussionId: d.id, soignantId: req.soignant.id, le });
  }
  res.json({ lus: r.modifiedCount });
};

/** Annuaire : soignants actifs avec qui démarrer une discussion. */
exports.annuaire = async (req, res) => {
  const soignants = await Soignant.find({ statut: 'Actif', _id: { $ne: req.soignant._id } }).select(CHAMPS_PROFIL).sort({ prenom: 1 });
  res.json(soignants.map(profil));
};
