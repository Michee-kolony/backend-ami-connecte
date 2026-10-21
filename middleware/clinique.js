const crypto = require('crypto');
const { ROLES_MEDECIN } = require('../models/Soignant');
const { journaliser } = require('../config/audit');

/** Identifiant de corrélation de chaque requête (renvoyé dans l'en-tête X-Request-Id). */
function identifierRequete(req, res, next) {
  req.requeteId = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requeteId);
  next();
}

/**
 * Dossier médical : réservé aux médecins (comptes actifs, rôle vérifié côté serveur).
 * Tout autre rôle, infirmier·ère compris, reçoit un 403 et le refus est journalisé.
 * À placer après authentifier.
 */
async function exigerMedecin(req, res, next) {
  if (ROLES_MEDECIN.includes(req.soignant?.role)) return next();
  await journaliser(req, {
    action: 'acces.refuse',
    resultat: 'refusé',
    ressource: { type: req.baseUrl.replace('/api/', ''), id: null },
    // Chemin demandé (identifiants seulement, jamais de corps de requête).
    details: { role: req.soignant?.role ?? null, chemin: req.path },
  });
  res.status(403).json({ message: 'Le dossier médical est réservé aux médecins.' });
}

module.exports = { identifierRequete, exigerMedecin };
