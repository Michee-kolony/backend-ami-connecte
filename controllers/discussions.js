// Discussions privées en temps réel : entre soignants (médecins et infirmier·ères), et entre une
// patiente (application mobile) et le soignant de son choix.
// Sécurité : participants seulement (vérifié à chaque requête), texte chiffré au repos,
// contenu jamais journalisé, taille et débit d'envoi limités.
const mongoose = require('mongoose');
const Discussion = require('../models/Discussion');
const MessageDiscussion = require('../models/MessageDiscussion');
const Soignant = require('../models/Soignant');
const Patiente = require('../models/Patiente');
const { urlSignee } = require('../config/r2');
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

/** Patiente vue par le soignant dans ses discussions (même forme qu'un soignant, rôle « Patiente »). */
async function profilPatiente(p) {
  return p ? {
    id: p.id, prenom: p.prenom, nom: p.nom, role: 'Patiente', photo: await urlSignee(p.photoCle), matricule: p.numero,
    statut: p.espaceEnLigne === 'Activé' ? 'Actif' : 'Inactif',
  } : null;
}

/** Soignant vu par la patiente : ni matricule ni coordonnées. */
async function profilPourPatiente(s) {
  return s ? {
    id: String(s._id), prenom: s.prenom, nom: s.nom, role: s.role,
    photo: (await urlSignee(s.photoCle)) ?? s.photo ?? null, statut: s.statut,
  } : null;
}

/** Participant connecté : soignant (espace administrateur) ou patiente (application mobile). */
const moiDe = (req) => req.soignant?._id ?? req.patiente._id;

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

/** Discussion dont l'utilisateur connecté est participant (sinon 404, sans révéler son existence). */
async function discussionDe(req) {
  const d = mongoose.isValidObjectId(req.params.id) && await Discussion.findById(req.params.id);
  if (!d || !d.aPourParticipant(moiDe(req))) throw erreur(404, 'Discussion introuvable.');
  return d;
}

/** Résumé d'une discussion : interlocuteur, dernier message, nombre de messages non lus. */
async function resume(d, moi, interlocuteur) {
  const [dernier, nonLus] = await Promise.all([
    MessageDiscussion.findOne({ discussionId: d._id }).sort({ createdAt: -1 }),
    MessageDiscussion.countDocuments({ discussionId: d._id, auteurId: { $ne: moi }, 'lusPar.soignantId': { $ne: moi } }),
  ]);
  return { id: d.id, interlocuteur, dernierMessage: dernier ? versClient(dernier) : null, nonLus, dernierMessageLe: d.dernierMessageLe };
}

/** Mes discussions (soignant) : avec des collègues et avec des patientes. */
exports.lister = async (req, res) => {
  const moi = req.soignant._id;
  const discussions = await Discussion.find({ participants: moi }).sort({ dernierMessageLe: -1, updatedAt: -1 })
    .populate('participants', CHAMPS_PROFIL);
  const ids = discussions.map((d) => d.patienteId).filter(Boolean);
  const patientes = new Map((await Patiente.find({ _id: { $in: ids } }).select('prenom nom numero photoCle espaceEnLigne'))
    .map((p) => [p.id, p]));
  res.json(await Promise.all(discussions.map(async (d) => resume(d, moi, d.patienteId
    ? await profilPatiente(patientes.get(String(d.patienteId)))
    : profil(d.participants.find((p) => !p._id.equals(moi)))))));
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

/** Limite de débit en mémoire (par participant, fenêtre glissante d'une minute). */
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
  const moi = moiDe(req);
  const texte = typeof req.body?.texte === 'string' ? req.body.texte.replace(/\r\n/g, '\n').trim() : '';
  if (!texte) throw erreur(400, 'Message vide.');
  if (texte.length > TAILLE_MAX) throw erreur(400, `Message trop long (${TAILLE_MAX} caractères au maximum).`);
  const autre = d.participants.find((p) => !p.equals(moi));
  if (d.patienteId?.equals(autre)) {
    if (!(await Patiente.exists({ _id: autre, espaceEnLigne: 'Activé' }))) throw erreur(409, 'Cette patiente n’a plus d’accès actif.');
  } else if (!(await Soignant.exists({ _id: autre, statut: 'Actif' }))) {
    throw erreur(409, 'Ce soignant n’a plus d’accès actif.');
  }
  verifierDebit(String(moi));

  const m = await MessageDiscussion.create({
    discussionId: d._id, auteurId: moi, contenu: chiffrer(texte),
    lusPar: [{ soignantId: moi, le: new Date() }],
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
  const moi = moiDe(req);
  const le = new Date();
  const r = await MessageDiscussion.updateMany(
    { discussionId: d._id, auteurId: { $ne: moi }, 'lusPar.soignantId': { $ne: moi } },
    { $push: { lusPar: { soignantId: moi, le } } },
  );
  // « soignantId » : celui qui a lu (soignant ou patiente), nom gardé pour l'espace administrateur.
  if (r.modifiedCount) {
    for (const p of d.participants) presence.emettre(String(p), 'discussion:lu', { discussionId: d.id, soignantId: String(moi), le });
  }
  res.json({ lus: r.modifiedCount });
};

/** Annuaire : soignants actifs avec qui démarrer une discussion. */
exports.annuaire = async (req, res) => {
  const soignants = await Soignant.find({ statut: 'Actif', _id: { $ne: req.soignant._id } }).select(CHAMPS_PROFIL).sort({ prenom: 1 });
  res.json(soignants.map(profil));
};

// --- Application mobile : la patiente écrit au soignant de son choix -------------------------

/** Soignants actifs à qui la patiente peut écrire. */
exports.annuairePatiente = async (req, res) => {
  const soignants = await Soignant.find({ statut: 'Actif' }).select(`${CHAMPS_PROFIL} photoCle`).sort({ prenom: 1 });
  res.json(await Promise.all(soignants.map(profilPourPatiente)));
};

/** Discussions de la patiente connectée. */
exports.listerPatiente = async (req, res) => {
  const moi = req.patiente._id;
  const discussions = await Discussion.find({ patienteId: moi }).sort({ dernierMessageLe: -1, updatedAt: -1 })
    .populate('participants', `${CHAMPS_PROFIL} photoCle`);
  res.json(await Promise.all(discussions.map(async (d) => resume(d, moi, await profilPourPatiente(d.participants.find((p) => !p._id.equals(moi)))))));
};

/** Ouvre (ou crée) la discussion de la patiente avec un soignant actif. */
exports.ouvrirPatiente = async (req, res) => {
  const soignantId = String(req.body?.soignantId || '');
  if (!mongoose.isValidObjectId(soignantId)) throw erreur(400, 'Soignant invalide.');
  const s = await Soignant.findById(soignantId).select(`${CHAMPS_PROFIL} photoCle`);
  if (!s || s.statut !== 'Actif') throw erreur(404, 'Soignant introuvable ou suspendu.');
  const p = req.patiente;
  const cle = Discussion.cleDe(s._id, p._id);
  let d = await Discussion.findOne({ cle });
  if (!d) {
    try {
      d = await Discussion.create({ participants: [s._id, p._id], patienteId: p._id, cle });
    } catch (err) {
      if (err.code !== 11000) throw err;
      d = await Discussion.findOne({ cle });
    }
  }
  res.status(201).json(await resume(d, p._id, await profilPourPatiente(s)));
};
