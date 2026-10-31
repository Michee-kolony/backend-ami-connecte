// Chat d'une urgence : patiente, chauffeur envoyé et régulation échangent dans une même
// conversation, en temps réel (« urgence:message »). Texte chiffré au repos.
// Accès : la patiente à ses urgences, le chauffeur à la mission qui lui est confiée, tout le personnel.
// À la fin de la mission (terminée, clôturée ou annulée), la conversation est supprimée définitivement.
const Urgence = require('../models/Urgence');
const MessageUrgence = require('../models/MessageUrgence');
const presence = require('../config/presence');
const notifications = require('../config/notifications');
const { chiffrer, dechiffrer } = require('../config/chiffrement');
const { erreur } = require('./saisie');
const { urgenceVisible } = require('../config/urgences');

const TAILLE_MAX = 1000;
/** Anti-saturation : un message toutes les 500 ms au plus par auteur. */
const INTERVALLE_MIN_MS = 500;
const derniersEnvois = new Map();

const versClient = (m, numero) => ({
  id: String(m._id),
  urgence: numero,
  auteur: { type: m.auteur.type, id: m.auteur.id, nom: m.auteur.nom },
  texte: dechiffrer(m.contenu) ?? '⚠ Message illisible (clé de chiffrement modifiée).',
  le: m.createdAt,
});

/** Auteur de la requête : régulation (personnel), patiente ou chauffeur. */
function auteurDe(req) {
  if (req.soignant) return { type: 'regulation', id: req.soignant.id, nom: `${req.soignant.prenom} ${req.soignant.nom}`.trim() };
  if (req.patiente) return { type: 'patiente', id: req.patiente.id, nom: `${req.patiente.prenom} ${req.patiente.nom}`.trim() };
  return { type: 'chauffeur', id: req.chauffeur.id, nom: `${req.chauffeur.prenom} ${req.chauffeur.nom}`.trim() };
}

/** Urgence lisible par l'auteur de la requête (404 sinon, sans révéler qu'elle existe). */
async function urgenceAccessible(req) {
  const numero = String(req.params.numero || '');
  const x = /^URG-\d+$/.test(numero) ? await Urgence.findOne({ numero }) : null;
  const autorise = x && ((req.soignant && urgenceVisible(x, req.etablissementId))
    || (req.patiente && String(x.patienteId) === req.patiente.id)
    || (req.chauffeur && x.chauffeurId && String(x.chauffeurId) === req.chauffeur.id));
  if (!autorise) throw erreur(404, 'Urgence introuvable.');
  return x;
}

exports.lister = async (req, res) => {
  const x = await urgenceAccessible(req);
  const messages = await MessageUrgence.find({ urgenceId: x._id }).sort({ createdAt: 1 }).limit(500);
  res.json(messages.map((m) => versClient(m, x.numero)));
};

exports.envoyer = async (req, res) => {
  const x = await urgenceAccessible(req);
  const texte = typeof req.body?.texte === 'string' ? req.body.texte.replace(/\r\n/g, '\n').trim() : '';
  if (!texte) throw erreur(400, 'Message vide.');
  if (texte.length > TAILLE_MAX) throw erreur(400, `Message trop long (${TAILLE_MAX} caractères au maximum).`);
  if (!x.estActive()) throw erreur(409, 'Cette mission est terminée : la conversation a été supprimée.');
  const auteur = auteurDe(req);
  const cle = `${auteur.type}:${auteur.id}`;
  if (Date.now() - (derniersEnvois.get(cle) ?? 0) < INTERVALLE_MIN_MS) throw erreur(429, 'Patientez un instant avant le message suivant.');
  derniersEnvois.set(cle, Date.now());

  const m = await MessageUrgence.create({ urgenceId: x._id, auteur, contenu: chiffrer(texte) });
  const message = versClient(m, x.numero);
  presence.emettreEtablissement(x.etablissementId, 'urgence:message', message);
  presence.emettrePatiente(String(x.patienteId), 'urgence:message', message);
  if (x.chauffeurId) presence.emettreChauffeur(String(x.chauffeurId), 'urgence:message', message);
  // Message pour la patiente : notification push (sans le contenu), au cas où l'application est fermée.
  if (auteur.type !== 'patiente') {
    notifications.notifierPatiente(x.patienteId, {
      titre: auteur.type === 'chauffeur' ? `Message de votre chauffeur ${auteur.nom}` : 'Message de la régulation',
      corps: 'Nouveau message au sujet de votre urgence. Ouvrez l’application pour le lire.',
      donnees: { type: 'urgence', urgence: x.numero },
    });
  }
  res.status(201).json(message);
};

/**
 * Suppression définitive de la conversation d'une urgence terminée, puis avis aux trois
 * applications (« urgence:conversation-supprimee ») pour qu'elles vident leur fil.
 */
async function supprimerConversation(x) {
  await MessageUrgence.deleteMany({ urgenceId: x._id });
  const avis = { urgence: x.numero };
  presence.emettreEtablissement(x.etablissementId, 'urgence:conversation-supprimee', avis);
  presence.emettrePatiente(String(x.patienteId), 'urgence:conversation-supprimee', avis);
  if (x.chauffeurId) presence.emettreChauffeur(String(x.chauffeurId), 'urgence:conversation-supprimee', avis);
}

module.exports.supprimerConversation = supprimerConversation;
