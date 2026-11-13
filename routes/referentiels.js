const express = require('express');
const { authentifier } = require('../middleware/auth');
const { PROVINCES_RDC } = require('../config/referentiels');
const { ZONES_SANTE_RDC } = require('../config/zonesSante');
const cpn = require('../config/cpn');
const accouchement = require('../config/accouchement');
const partogramme = require('../config/partogramme');
const vaccination = require('../config/vaccination');
const ficheEtablissement = require('../config/ficheEtablissement');
const ficheSpecifique = require('../config/ficheSpecifique');

const router = express.Router();

router.use(authentifier);

/** Les 26 provinces de la RDC, pour les listes déroulantes du tableau de bord. */
router.get('/provinces', (req, res) => {
  res.json(PROVINCES_RDC);
});

/** Les 519 zones de santé, regroupées par province. */
router.get('/zones-sante', (req, res) => {
  res.json(ZONES_SANTE_RDC);
});

/** Listes de la fiche CPN (antécédents, signes, mesures préventives, laboratoire, référence). */
router.get('/cpn', (req, res) => {
  res.json(cpn);
});

/** Listes du dossier d'accouchement et seuils du partogramme. */
router.get('/accouchement', (req, res) => {
  const { BCF, PHASE_ACTIVE_CM, DILATATION_COMPLETE_CM, VITESSE_CM_H, DECALAGE_ACTION_H, STAGNATION_H } = partogramme;
  res.json({ ...accouchement, partogramme: { BCF, PHASE_ACTIVE_CM, DILATATION_COMPLETE_CM, VITESSE_CM_H, DECALAGE_ACTION_H, STAGNATION_H } });
});

/**
 * Fiche AMI d'un établissement : listes de choix de la fiche générale et description des volets
 * spécifiques (hôpital, centre de santé) pour construire le formulaire selon le type de structure.
 */
router.get('/fiche-etablissement', (req, res) => {
  const listes = Object.fromEntries(Object.entries(ficheEtablissement).filter(([, v]) => Array.isArray(v)));
  res.json({
    listes,
    profilDuType: ficheSpecifique.PROFIL_DU_TYPE,
    volets: { hopital: ficheSpecifique.formulaire('hopital'), centreSante: ficheSpecifique.formulaire('centreSante') },
  });
});

/** Calendrier vaccinal (PEV RDC) et suivi préscolaire. */
router.get('/vaccination', (req, res) => {
  res.json({ calendrier: vaccination.CALENDRIER, types: vaccination.TYPES, toleranceJours: vaccination.TOLERANCE_JOURS });
});

module.exports = router;
