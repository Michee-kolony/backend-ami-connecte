const express = require('express');
const { authentifier } = require('../middleware/auth');
const ctrl = require('../controllers/etablissements');

const router = express.Router();

// Personnel soignant : consultation seulement. L'enregistrement, la modification, la suspension et
// la suppression des établissements sont réservés au comité de pilotage (routes/comite.js).
router.use(authentifier);

router.get('/', ctrl.lister);
router.get('/:id', ctrl.obtenir);

module.exports = router;
