const express = require('express');
const { authentifier } = require('../middleware/auth');
const { televerserPhoto } = require('../middleware/upload');
const ctrl = require('../controllers/auth');

const router = express.Router();

router.post('/connexion', ctrl.connexion);
router.get('/moi', authentifier, ctrl.moi);
router.patch('/moi', authentifier, televerserPhoto, ctrl.modifierProfil);
router.put('/moi/mot-de-passe', authentifier, ctrl.changerMotDePasse);

module.exports = router;
