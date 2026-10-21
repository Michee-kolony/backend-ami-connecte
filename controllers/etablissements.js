const mongoose = require('mongoose');
const Etablissement = require('../models/Etablissement');
const Soignant = require('../models/Soignant');
const { envoyerFichier, supprimerFichier } = require('../config/r2');

const DOSSIER_PHOTOS = 'etablissement';
const MAX_PHOTOS = 6;

const CHAMPS = [
  'nom', 'type', 'secteur', 'province', 'zoneSante', 'aireSante', 'adresse', 'telephone',
  'email', 'responsable', 'fonctionResponsable',
];

/** Recopie les champs du formulaire (multipart : tout arrive en texte) dans le document. */
function appliquer(etablissement, d) {
  for (const champ of CHAMPS) {
    if (d[champ] !== undefined) etablissement[champ] = d[champ];
  }
  const nombre = (v) => (v === undefined || v === '' || v === 'null' ? null : Number(v));
  if (d.latitude !== undefined) etablissement.latitude = nombre(d.latitude);
  if (d.longitude !== undefined) etablissement.longitude = nombre(d.longitude);
  if (d.lits !== undefined) etablissement.lits = nombre(d.lits) || 0;
  if (d.services !== undefined) etablissement.services = JSON.parse(d.services);
}

function erreurValidation(err) {
  return Object.values(err.errors || {})[0]?.message || 'Données invalides.';
}

async function nomDejaPris(nom, province, saufId) {
  const filtre = { nom: new RegExp(`^${String(nom).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), province };
  if (saufId) filtre._id = { $ne: saufId };
  return Etablissement.exists(filtre);
}

/** Envoie les nouvelles photos dans R2 ; en cas d'échec, retire celles déjà envoyées. */
async function envoyerPhotos(fichiers) {
  const envoyees = [];
  try {
    for (const f of fichiers) envoyees.push(await envoyerFichier(f, DOSSIER_PHOTOS));
  } catch (err) {
    await Promise.all(envoyees.map((p) => supprimerFichier(p.cle).catch(() => {})));
    throw err;
  }
  return envoyees.map(({ cle, url }) => ({ cle, url }));
}

function supprimerPhotos(photos) {
  return Promise.all(photos.map((p) => supprimerFichier(p.cle)
    .catch((err) => console.error(`Photo ${p.cle} non supprimée de R2 :`, err.message))));
}

exports.lister = async (req, res) => {
  res.json(await Etablissement.find().sort({ createdAt: -1 }));
};

exports.obtenir = async (req, res) => {
  const e = mongoose.isValidObjectId(req.params.id) && await Etablissement.findById(req.params.id);
  if (!e) return res.status(404).json({ message: 'Établissement introuvable.' });
  res.json(e);
};

exports.creer = async (req, res) => {
  const fichiers = req.files || [];
  if (fichiers.length > MAX_PHOTOS) return res.status(400).json({ message: `${MAX_PHOTOS} photos au maximum.` });

  const e = new Etablissement({ creePar: req.soignant._id });
  try {
    appliquer(e, req.body);
  } catch {
    return res.status(400).json({ message: 'Services invalides.' });
  }
  if (!e.province) return res.status(400).json({ message: 'La province est obligatoire.' });
  if (await nomDejaPris(e.nom, e.province)) {
    return res.status(409).json({ message: 'Un établissement porte déjà ce nom dans cette province.' });
  }
  e.code = await Etablissement.prochainCode(e.province);
  try {
    await e.validate();
  } catch (err) {
    return res.status(400).json({ message: erreurValidation(err) });
  }

  e.photos = await envoyerPhotos(fichiers);
  try {
    await e.save();
  } catch (err) {
    await supprimerPhotos(e.photos);
    if (err.code === 11000) return res.status(409).json({ message: 'Code déjà attribué, réessayez.' });
    throw err;
  }
  res.status(201).json(e);
};

/**
 * Modification : champs du formulaire + `photosConservees` (URLs des photos gardées, JSON)
 * + nouvelles photos. Les photos retirées sont supprimées de R2.
 */
exports.modifier = async (req, res) => {
  const e = mongoose.isValidObjectId(req.params.id) && await Etablissement.findById(req.params.id);
  if (!e) return res.status(404).json({ message: 'Établissement introuvable.' });

  let conservees;
  try {
    appliquer(e, req.body);
    conservees = req.body.photosConservees !== undefined ? JSON.parse(req.body.photosConservees) : e.photos.map((p) => p.url);
  } catch {
    return res.status(400).json({ message: 'Données invalides.' });
  }
  const fichiers = req.files || [];
  const gardees = e.photos.filter((p) => conservees.includes(p.url));
  const retirees = e.photos.filter((p) => !conservees.includes(p.url));
  if (gardees.length + fichiers.length > MAX_PHOTOS) {
    return res.status(400).json({ message: `${MAX_PHOTOS} photos au maximum.` });
  }
  if ((e.isModified('nom') || e.isModified('province')) && await nomDejaPris(e.nom, e.province, e._id)) {
    return res.status(409).json({ message: 'Un établissement porte déjà ce nom dans cette province.' });
  }
  try {
    await e.validate();
  } catch (err) {
    return res.status(400).json({ message: erreurValidation(err) });
  }

  const nouvelles = await envoyerPhotos(fichiers);
  e.photos = [...gardees, ...nouvelles];
  try {
    await e.save();
  } catch (err) {
    await supprimerPhotos(nouvelles);
    throw err;
  }
  await supprimerPhotos(retirees);
  res.json(e);
};

exports.basculerStatut = async (req, res) => {
  const e = mongoose.isValidObjectId(req.params.id) && await Etablissement.findById(req.params.id);
  if (!e) return res.status(404).json({ message: 'Établissement introuvable.' });
  e.statut = e.statut === 'Actif' ? 'Suspendu' : 'Actif';
  await e.save();
  res.json(e);
};

/** Suppression refusée tant que du personnel y est rattaché, pour ne laisser personne sans établissement. */
exports.supprimer = async (req, res) => {
  const e = mongoose.isValidObjectId(req.params.id) && await Etablissement.findById(req.params.id);
  if (!e) return res.status(404).json({ message: 'Établissement introuvable.' });
  const rattaches = await Soignant.countDocuments({ 'affectations.etablissementId': e.id });
  if (rattaches) {
    return res.status(409).json({
      message: `${rattaches} soignant(s) sont rattachés à cet établissement. Retirez-les ou suspendez l’établissement à la place.`,
    });
  }
  await e.deleteOne();
  await supprimerPhotos(e.photos);
  res.status(204).end();
};
