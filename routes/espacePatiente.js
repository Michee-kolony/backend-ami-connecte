// Espace patiente (application mobile) : jeton propre à la patiente, lecture de ses seules données.
const express = require('express');
const { authentifierPatiente } = require('../middleware/patiente');
const ctrl = require('../controllers/espacePatiente');

const router = express.Router();

router.post('/connexion', ctrl.connexion);

router.use(authentifierPatiente);
router.get('/moi', ctrl.moi);
router.put('/moi/mot-de-passe', ctrl.changerMotDePasse);
router.get('/accueil', ctrl.accueil);
router.get('/rendez-vous', ctrl.rendezVous);
router.get('/enfants', ctrl.enfants);
router.get('/enfants/:id', ctrl.enfant);
router.get('/accouchements', ctrl.accouchements);
router.get('/conseils', ctrl.conseils);

module.exports = router;
