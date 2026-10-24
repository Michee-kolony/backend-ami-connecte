const express = require('express');
const { authentifier } = require('../middleware/auth');
const ctrl = require('../controllers/statistiques');

const router = express.Router();

// Indicateurs agrégés du tableau de bord : tout le personnel soignant connecté.
router.use(authentifier);

router.get('/patientes', ctrl.patientes);
router.get('/enfants', ctrl.enfants);

module.exports = router;
