const express = require('express');
const { authentifier } = require('../middleware/auth');
const { PROVINCES_RDC } = require('../config/referentiels');

const router = express.Router();

router.use(authentifier);

/** Les 26 provinces de la RDC, pour les listes déroulantes du tableau de bord. */
router.get('/provinces', (req, res) => {
  res.json(PROVINCES_RDC);
});

module.exports = router;
