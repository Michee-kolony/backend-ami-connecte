// Application ami-connecte-chauffeur : jeton propre au chauffeur (typ « chauffeur »).
const express = require('express');
const { authentifierChauffeur } = require('../middleware/chauffeur');
const ctrl = require('../controllers/espaceChauffeur');
const urgences = require('../controllers/urgences');
const messages = require('../controllers/messagesUrgence');

const router = express.Router();

router.post('/connexion', ctrl.connexion);

router.use(authentifierChauffeur);
router.get('/moi', ctrl.moi);
router.put('/moi/mot-de-passe', ctrl.changerMotDePasse);
router.get('/mission', urgences.missionEnCours);
router.get('/missions', urgences.historiqueMissions);
router.post('/missions/:numero/statut', urgences.changerStatutCourse);
// Chat de la mission avec la patiente et la régulation
router.get('/missions/:numero/messages', messages.lister);
router.post('/missions/:numero/messages', messages.envoyer);
// Position GPS par HTTP, quand le temps réel (socket.io) est coupé.
router.post('/position', urgences.position);

module.exports = router;
