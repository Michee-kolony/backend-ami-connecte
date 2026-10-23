// Espace patiente (application mobile) : jeton propre à la patiente, lecture de ses seules données.
const express = require('express');
const { authentifierPatiente } = require('../middleware/patiente');
const ctrl = require('../controllers/espacePatiente');
const discussions = require('../controllers/discussions');

const router = express.Router();

router.post('/connexion', ctrl.connexion);

router.use(authentifierPatiente);
router.get('/moi', ctrl.moi);
router.put('/moi/mot-de-passe', ctrl.changerMotDePasse);
router.get('/accueil', ctrl.accueil);
router.get('/rendez-vous', ctrl.rendezVous);
router.get('/grossesse', ctrl.grossesse);
router.get('/enfants', ctrl.enfants);
router.get('/enfants/:id', ctrl.enfant);
router.get('/accouchements', ctrl.accouchements);
router.get('/conseils', ctrl.conseils);
router.post('/conseils/articles/:id/jaime', ctrl.aimerArticle);
router.post('/conseils/articles/:id/commentaires', ctrl.commenterArticle);
router.delete('/conseils/articles/:id/commentaires/:cid', ctrl.supprimerCommentaireArticle);

// Messagerie avec les soignants (mêmes discussions chiffrées que l'espace administrateur).
router.get('/soignants', discussions.annuairePatiente);
router.get('/discussions', discussions.listerPatiente);
router.post('/discussions', discussions.ouvrirPatiente);
router.get('/discussions/:id/messages', discussions.messages);
router.post('/discussions/:id/messages', discussions.envoyer);
router.post('/discussions/:id/lu', discussions.marquerLu);

module.exports = router;
