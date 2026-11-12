const mongoose = require('mongoose');
const Etablissement = require('../models/Etablissement');
const { modulesActifs } = require('../config/ficheEtablissement');

/**
 * Étape 6 de la fiche AMI : un module (CPN, Accouchement, Vaccination) n'est ouvert que si le
 * service correspondant est fonctionnel et la fiche de l'établissement validée puis activée.
 * Les établissements enregistrés avant la fiche AMI ne sont pas restreints. À placer après
 * authentifier (établissement de connexion : req.etablissementId).
 */
function exigerModule(module) {
  return async (req, res, next) => {
    const id = req.etablissementId;
    if (!id || !mongoose.isValidObjectId(id)) return next();
    const e = await Etablissement.findById(id).select('nom fiche.circuit fiche.services');
    const modules = e ? modulesActifs(e) : null;
    if (modules === null || modules.includes(module)) return next();
    const statut = e.fiche.circuit.statut;
    res.status(403).json({
      message: statut === 'Active'
        ? `Le module ${module} n’est pas ouvert pour ${e.nom} : le service n’est pas déclaré fonctionnel dans la fiche de l’établissement (étape 6).`
        : `Le module ${module} sera ouvert à l’activation de la fiche de ${e.nom} (statut actuel : ${statut}).`,
      module,
    });
  };
}

module.exports = { exigerModule };
