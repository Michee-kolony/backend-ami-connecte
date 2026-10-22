// Grossesses, consultations, rendez-vous et journal d'audit : médecins uniquement,
// sauf la lecture de l'agenda, ouverte aux infirmier·ères.
const express = require('express');
const { authentifier, exigerRole } = require('../middleware/auth');
const { exigerMedecin } = require('../middleware/clinique');
const { ROLES_GESTION } = require('../models/Soignant');
const patientes = require('../controllers/patientes');
const consultations = require('../controllers/consultations');
const rendezVous = require('../controllers/rendezVous');
const echographies = require('../controllers/echographies');
const { televerserFichiersEchographie } = require('../middleware/upload');

const grossesses = express.Router();
grossesses.use(authentifier, exigerMedecin);
grossesses.patch('/:id', patientes.modifierGrossesse);
grossesses.put('/:id/datation', patientes.dater);
grossesses.post('/:id/issue', patientes.issue);
grossesses.get('/:id/consultations', consultations.lister);
grossesses.post('/:id/consultations', consultations.creer);
grossesses.get('/:id/echographies', echographies.lister);
grossesses.post('/:id/echographies', televerserFichiersEchographie, echographies.creer);

const consult = express.Router();
consult.use(authentifier, exigerMedecin);
consult.get('/:id', consultations.obtenir);
consult.patch('/:id', consultations.modifier);
consult.post('/:id/finaliser', consultations.finaliser);
consult.post('/:id/addenda', consultations.ajouterAddendum);
consult.post('/:id/annuler', consultations.annuler);
// Pas de route de suppression : une consultation est annulée avec motif, jamais effacée.

const rdv = express.Router();
rdv.use(authentifier);
rdv.get('/', rendezVous.agenda);
rdv.patch('/:id', exigerMedecin, rendezVous.modifier);

const journal = express.Router();
journal.use(authentifier, exigerMedecin, exigerRole(...ROLES_GESTION));
journal.get('/', rendezVous.journalGlobal);

module.exports = { grossesses, consultations: consult, rendezVous: rdv, journal };
