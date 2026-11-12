const express = require('express');
const { authentifier } = require('../middleware/auth');
const ctrl = require('../controllers/etablissements');
const fiche = require('../controllers/ficheEtablissement');

const router = express.Router();

// Personnel soignant : consultation seulement. L'enregistrement, la modification, la suspension et
// la suppression des établissements sont réservés au comité de pilotage (routes/comite.js).
router.use(authentifier);

router.get('/', ctrl.lister);
// Fiche AMI : le médecin chef de l'établissement la consulte et en complète les champs facultatifs.
router.get('/:id/fiche', fiche.obtenirChef);
router.patch('/:id/fiche', fiche.modifierChef);
router.get('/:id', ctrl.obtenir);

module.exports = router;
