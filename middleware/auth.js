const jwt = require('jsonwebtoken');
const Soignant = require('../models/Soignant');

/** Vérifie le jeton JWT et charge le soignant connecté dans req.soignant. */
async function authentifier(req, res, next) {
  const [type, jeton] = (req.headers.authorization || '').split(' ');
  if (type !== 'Bearer' || !jeton) return res.status(401).json({ message: 'Authentification requise.' });
  try {
    const { sub, etablissement, typ } = jwt.verify(jeton, process.env.JWT_SECRET);
    // Jeton de l'espace patiente : jamais accepté sur les routes du personnel.
    if (typ === 'patiente' || typ === 'chauffeur') return res.status(403).json({ message: 'Accès réservé au personnel soignant.' });
    const soignant = await Soignant.findById(sub);
    if (!soignant || soignant.statut !== 'Actif') return res.status(401).json({ message: 'Compte inactif ou introuvable.' });
    req.soignant = soignant;
    /** Établissement choisi à la connexion (null pour le médecin chef sans établissement). */
    req.etablissementId = etablissement ?? null;
    next();
  } catch {
    res.status(401).json({ message: 'Session expirée, reconnectez-vous.' });
  }
}

/** Restreint la route aux rôles donnés (à placer après authentifier). */
function exigerRole(...roles) {
  return (req, res, next) => roles.includes(req.soignant.role)
    ? next()
    : res.status(403).json({ message: `Action réservée au rôle : ${roles.join(', ')}.` });
}

module.exports = { authentifier, exigerRole };
