// Dossier d'accouchement (salle de travail → sortie) : médecins et sages-femmes.
// Infirmier·ères refusé·es (403 journalisé) ; elles et ils accèdent au carnet de l'enfant (/api/enfants).
const express = require('express');
const { authentifier } = require('../middleware/auth');
const { televerserPhoto } = require('../middleware/upload');
const { exigerMaternite, exigerMedecin } = require('../middleware/clinique');
const ctrl = require('../controllers/accouchements');

const router = express.Router();
router.use(authentifier, exigerMaternite);

router.get('/', ctrl.lister);
router.get('/alertes', ctrl.alertes);
// Module 1 — Admission. Admission directe (sans dossier) : formulaire multipart, données JSON
// dans « donnees », photo de la patiente (obligatoire) dans « photo ».
router.post('/', televerserPhoto, ctrl.admettre);
router.get('/:id', ctrl.obtenir);
router.patch('/:id/admission', ctrl.modifierAdmission);
// Module 2 — Examen clinique d'entrée
router.put('/:id/examen-clinique', ctrl.examiner);
// Module 3 — Surveillance du travail et partogramme
router.post('/:id/surveillances', ctrl.surveiller);
router.get('/:id/partogramme', ctrl.partogramme);
router.post('/:id/alertes/:alerteId/acquitter', ctrl.acquitterAlerte);
// Module 4 — Accouchement et délivrance
router.put('/:id/accouchement', ctrl.accoucher);
// Module 5 — Nouveau-né (dossier de l'enfant rattaché à la mère)
// Formulaire multipart : données JSON dans « donnees », photo du bébé dans « photo ».
router.post('/:id/nouveau-nes', televerserPhoto, ctrl.ajouterNouveauNe);
// Module 6 — Post-partum, sortie, clôture
router.post('/:id/post-partum/surveillances', ctrl.surveillerPostPartum);
router.post('/:id/post-partum/traitements', ctrl.ajouterTraitement);
router.post('/:id/post-partum/traitements/:traitementId/administrer', ctrl.administrerTraitement);
router.put('/:id/sortie', ctrl.sortir);
router.post('/:id/cloturer', ctrl.cloturer);
// Suppression définitive du dossier entier : médecins seulement, numéro du dossier retapé.
// Les saisies, elles, ne sont jamais effacées une à une.
router.delete('/:id', exigerMedecin, ctrl.supprimer);

module.exports = router;
