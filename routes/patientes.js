const express = require('express');
const { authentifier, exigerRole } = require('../middleware/auth');
const { televerserPhoto } = require('../middleware/upload');
const { ROLES_GESTION } = require('../models/Soignant');
const { exigerMedecin } = require('../middleware/clinique');
const patientes = require('../controllers/patientes');
const rendezVous = require('../controllers/rendezVous');
const carte = require('../controllers/carte');

const router = express.Router();

router.use(authentifier);

// Suivi (tout le personnel soignant) : recherche minimisée, grossesse en cours et rendez-vous.
router.get('/', patientes.rechercher);
router.get('/:id/suivi', patientes.suivi);

// Dossier médical complet : médecins uniquement (infirmier·ères refusé·es et journalisé·es).
router.use(exigerMedecin);

router.get('/doublons', patientes.doublons);
router.post('/', televerserPhoto, patientes.creer);
router.get('/:id', patientes.dossier);
router.patch('/:id', patientes.modifier);
router.delete('/:id', exigerRole(...ROLES_GESTION), patientes.supprimer);
router.get('/:id/journal', patientes.journal);
router.get('/:id/carte', carte.carte);
router.post('/:id/grossesses', patientes.nouvelleGrossesse);
router.get('/:id/rendez-vous', rendezVous.lister);
router.post('/:id/rendez-vous', rendezVous.creer);

module.exports = router;
