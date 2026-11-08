// Application RECO (espace /reco d'ami-sante) : jeton propre au relais communautaire (typ « reco »).
const express = require('express');
const { authentifierReco } = require('../middleware/reco');
const ctrl = require('../controllers/espaceReco');
const discussions = require('../controllers/discussions');

const router = express.Router();

router.post('/connexion', ctrl.connexion);

router.use(authentifierReco);
router.get('/moi', ctrl.moi);
router.put('/moi/mot-de-passe', ctrl.changerMotDePasse);
router.get('/referentiel', ctrl.referentiel);
router.get('/taches', ctrl.taches);
// Tableau de bord du RECO : ses tâches (résolues, non résolues, en retard…) et ses actions.
router.get('/tableau-de-bord', ctrl.tableauDeBord);
// Action sur une tâche (accepter, tentative, visite, orientation, refus/report, appui, urgence).
router.post('/taches/:numero/actions', ctrl.agir);
// Actions faites hors connexion, renvoyées ensemble à la reconnexion (sans doublon).
router.post('/synchroniser', ctrl.synchroniser);
router.post('/signalements', ctrl.signaler);
router.get('/alertes', ctrl.alertes);
router.post('/alertes/:id/accuser', ctrl.accuserAlerte);
// Messagerie avec les soignants et les chauffeurs de son établissement (discussions chiffrées).
router.get('/contacts', discussions.contactsReco);
router.get('/discussions', discussions.listerReco);
router.post('/discussions', discussions.ouvrirReco);
router.get('/discussions/:id/messages', discussions.messages);
router.post('/discussions/:id/messages', discussions.envoyer);
router.post('/discussions/:id/lu', discussions.marquerLu);

module.exports = router;
