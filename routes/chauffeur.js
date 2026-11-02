// Application ami-connecte-chauffeur : jeton propre au chauffeur (typ « chauffeur »).
const express = require('express');
const { authentifierChauffeur } = require('../middleware/chauffeur');
const ctrl = require('../controllers/espaceChauffeur');
const urgences = require('../controllers/urgences');
const messages = require('../controllers/messagesUrgence');
const discussions = require('../controllers/discussions');

const router = express.Router();

router.post('/connexion', ctrl.connexion);

router.use(authentifierChauffeur);
router.get('/moi', ctrl.moi);
router.put('/moi/mot-de-passe', ctrl.changerMotDePasse);
router.get('/mission', urgences.missionEnCours);
router.get('/missions', urgences.historiqueMissions);
// Tableau de bord : courses effectuées, délais moyens, activité de la semaine.
router.get('/statistiques', urgences.statistiquesChauffeur);
router.post('/missions/:numero/statut', urgences.changerStatutCourse);
// Chat de la mission avec la patiente et la régulation
router.get('/missions/:numero/messages', messages.lister);
router.post('/missions/:numero/messages', messages.envoyer);
// Messagerie avec les RECO de son établissement (discussions chiffrées).
router.get('/recos', discussions.contactsChauffeur);
router.get('/discussions', discussions.listerChauffeur);
router.post('/discussions', discussions.ouvrirChauffeur);
router.get('/discussions/:id/messages', discussions.messages);
router.post('/discussions/:id/messages', discussions.envoyer);
router.post('/discussions/:id/lu', discussions.marquerLu);
// Position GPS par HTTP, quand le temps réel (socket.io) est coupé.
router.post('/position', urgences.position);

module.exports = router;
