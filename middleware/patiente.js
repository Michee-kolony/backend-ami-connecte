const jwt = require('jsonwebtoken');
const Patiente = require('../models/Patiente');

/**
 * Espace patiente (application mobile) : vérifie le jeton de la patiente et la charge dans
 * req.patiente. Un jeton de soignant est refusé ; la patiente ne lit que ses propres données.
 */
async function authentifierPatiente(req, res, next) {
  const [type, jeton] = (req.headers.authorization || '').split(' ');
  if (type !== 'Bearer' || !jeton) return res.status(401).json({ message: 'Authentification requise.' });
  try {
    const { sub, typ } = jwt.verify(jeton, process.env.JWT_SECRET);
    if (typ !== 'patiente') return res.status(403).json({ message: 'Espace réservé aux patientes.' });
    const patiente = await Patiente.findById(sub);
    if (!patiente || patiente.espaceEnLigne !== 'Activé') return res.status(401).json({ message: 'Compte inactif ou introuvable.' });
    req.patiente = patiente;
    next();
  } catch {
    res.status(401).json({ message: 'Session expirée, reconnectez-vous.' });
  }
}

module.exports = { authentifierPatiente };
