// Module ÉPIDÉMIOLOGIE (dix sous-fenêtres) : /api/epidemiologie. Tout le personnel connecté
// consulte les agrégats ; saisie, planification, paramétrage et validation sont contrôlés par le
// serveur dans les contrôleurs (config/epidemiologie.js, ROLES_*).
const express = require('express');
const { authentifier } = require('../middleware/auth');
const commun = require('../controllers/epidemiologie/commun');
const referentiel = require('../controllers/epidemiologie/referentiel');
const tableau = require('../controllers/epidemiologie/tableauDeBord');
const demographie = require('../controllers/epidemiologie/demographie');
const parametres = require('../controllers/epidemiologie/parametres');
const cibles = require('../controllers/epidemiologie/cibles');
const planification = require('../controllers/epidemiologie/planification');
const surveillance = require('../controllers/epidemiologie/surveillance');
const morbiMortalite = require('../controllers/epidemiologie/morbiMortalite');
const couvertures = require('../controllers/epidemiologie/couvertures');
const alertes = require('../controllers/epidemiologie/alertes');
const rapports = require('../controllers/epidemiologie/rapports');
const tracabilite = require('../controllers/epidemiologie/tracabilite');

const router = express.Router();
router.use(authentifier);

// Socle commun et vue générale
router.get('/referentiel', referentiel.referentiel);
router.get('/tableau-de-bord', tableau.tableauDeBord);
router.get('/territoires', referentiel.territoires);
router.post('/territoires', referentiel.creerTerritoire);
router.post('/territoires/synchroniser', referentiel.synchroniserRoute);
router.patch('/territoires/:code', referentiel.modifierTerritoire);

// 1. Référentiel démographique
router.get('/populations', demographie.lister);
router.get('/populations/synthese', demographie.synthese);
router.get('/populations/:id', demographie.obtenir);
router.post('/populations', demographie.creer);
router.patch('/populations/:id', demographie.modifier);

// 2. Paramètres et coefficients (et catalogue des indicateurs de couverture)
router.get('/coefficients', parametres.listerCoefficients);
router.get('/coefficients/applicables', parametres.applicables);
router.post('/coefficients', parametres.creerCoefficient);
router.patch('/coefficients/:id', parametres.modifierCoefficient);
router.get('/indicateurs', parametres.listerIndicateurs);
router.post('/indicateurs', parametres.creerIndicateur);
router.patch('/indicateurs/:id', parametres.modifierIndicateur);

// 3. Calcul des populations cibles
router.get('/cibles', cibles.lister);
router.get('/cibles/synthese', cibles.synthese);
router.post('/cibles/calcul', cibles.lancer);
router.post('/cibles/simulation', cibles.simuler);
router.get('/cibles/:id', cibles.obtenir);

// 4. Planification et répartition
router.get('/plans', planification.lister);
router.get('/plans/tableau', planification.tableau);
router.post('/plans', planification.creer);
router.patch('/plans/:id', planification.modifier);
router.get('/plans/:id/suivi', planification.suivi);
router.get('/plans/:id/proposition-geographique', planification.propositionGeographique);

// 5. Surveillance épidémiologique
router.get('/surveillance/tableau', surveillance.tableau);
router.get('/evenements', surveillance.listerEvenements);
router.post('/evenements', surveillance.notifier);
router.get('/evenements/:id', surveillance.obtenirEvenement);
router.patch('/evenements/:id', surveillance.modifierEvenement);
router.put('/evenements/:id/investigation', surveillance.investigation);
router.post('/evenements/:id/suivi', surveillance.suivi);
router.post('/evenements/:id/etat', surveillance.changerEtat);
router.get('/cas', surveillance.listerCas);
router.post('/cas', surveillance.enregistrerCas);
router.patch('/cas/:id', surveillance.modifierCas);

// 6. Morbidité et mortalité
router.get('/morbi-mortalite/analyse', morbiMortalite.analyse);
router.get('/morbidite', morbiMortalite.listerMorbidite);
router.post('/morbidite', morbiMortalite.enregistrerMorbidite);
router.patch('/morbidite/:id', morbiMortalite.modifierMorbidite);
router.get('/deces', morbiMortalite.listerDeces);
router.get('/deces/signalements', morbiMortalite.signalements);
router.post('/deces', morbiMortalite.enregistrerDeces);
router.patch('/deces/:id', morbiMortalite.modifierDeces);

// 7. Couvertures sanitaires
router.get('/couvertures', couvertures.couvertures);
router.get('/couvertures/structures', couvertures.structures);

// 8. Alertes et insuffisances
router.get('/alertes', alertes.lister);
router.get('/alertes/tableau', alertes.tableau);
router.get('/alertes/responsables', alertes.responsables);
router.post('/alertes', alertes.creer);
router.post('/alertes/detection', alertes.detection);
router.get('/alertes/regles', alertes.listerRegles);
router.post('/alertes/regles', alertes.creerRegle);
router.put('/alertes/regles/:code', alertes.modifierRegle);
router.post('/alertes/regles/:code/activer', alertes.activerRegle);
router.post('/alertes/regles/:code/:action', alertes.statutRegle);
router.get('/alertes/:numero', alertes.obtenir);
router.post('/alertes/:numero/attribuer', alertes.attribuer);
router.post('/alertes/:numero/traiter', alertes.traiter);
router.post('/alertes/:numero/resoudre', alertes.resoudre);
router.post('/alertes/:numero/cloturer', alertes.cloturer);
router.post('/alertes/:numero/lier', alertes.lier);

// 9. Rapports et exportation
router.get('/rapports', rapports.lister);
router.get('/rapports/statistiques', rapports.statistiques);
router.post('/rapports', rapports.generer);
router.get('/rapports/:numero', rapports.obtenir);
router.post('/rapports/:numero/regenerer', rapports.regenerer);
router.post('/rapports/:numero/valider', rapports.valider);
router.get('/rapports/:numero/export', rapports.exporter);

// 10. Historique, validation et traçabilité
router.get('/validation/en-attente', tracabilite.enAttente);
router.get('/validation/validees', tracabilite.validees);
router.get('/validation/rejetees', tracabilite.rejetees);
router.get('/validation/statistiques', tracabilite.statistiques);
router.get('/historique/modifications', tracabilite.modifications);
router.get('/historique/journal', tracabilite.journal);
router.get('/historique/calculs-rapports', tracabilite.calculsEtRapports);
// Cycle commun de validation : type = population, coefficient, calcul, plan, indicateur, evenement, cas, morbidite, deces.
router.post('/donnees/:type/:id/soumettre', commun.soumettreRoute);
router.post('/donnees/:type/:id/decision', commun.deciderRoute);
router.post('/donnees/:type/:id/archiver', commun.archiverRoute);
router.get('/donnees/:type/:id/controle', commun.controleRoute);
router.get('/donnees/:type/:id/historique', commun.historiqueRoute);

module.exports = router;
