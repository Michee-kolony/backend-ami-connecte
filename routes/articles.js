// Articles de conseils : médecins uniquement (publication, lecture, j'aime, commentaires).
// Les infirmier·ères sont refusé·es côté serveur.
const express = require('express');
const { authentifier } = require('../middleware/auth');
const { televerserMediasArticle } = require('../middleware/upload');
const { ROLES_MEDECIN } = require('../models/Soignant');
const articles = require('../controllers/articles');

const router = express.Router();

router.use(authentifier, (req, res, next) => (ROLES_MEDECIN.includes(req.soignant.role)
  ? next()
  : res.status(403).json({ message: 'Les articles de conseils sont réservés aux médecins.' })));

router.get('/', articles.lister);
router.post('/', televerserMediasArticle, articles.creer);
router.get('/:id', articles.obtenir);
router.patch('/:id', articles.modifier);
router.delete('/:id', articles.supprimer);
router.post('/:id/approuver', articles.approuver);
router.post('/:id/jaime', articles.aimer);
router.post('/:id/commentaires', articles.commenter);
router.delete('/:id/commentaires/:cid', articles.supprimerCommentaire);
router.post('/:id/commentaires/:cid/reponses', articles.repondre);
router.delete('/:id/commentaires/:cid/reponses/:rid', articles.supprimerReponse);

module.exports = router;
