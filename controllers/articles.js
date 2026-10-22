const mongoose = require('mongoose');
const Article = require('../models/Article');
const { auteurDe } = require('../models/commun');
const { ROLES_GESTION } = require('../models/Soignant');
const { journaliser } = require('../config/audit');
const { envoyerFichier, supprimerFichier } = require('../config/r2');

const DOSSIER_MEDIAS = 'articles';
const PAR_PAGE_MAX = 30;
const IMAGE_TAILLE_MAX = 5 * 1024 * 1024;

const erreur = (status, message) => Object.assign(new Error(message), { status });
const texte = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));

/** Le médecin chef peut tout supprimer ; les autres, seulement ce qu'ils ont publié. */
const peutSupprimer = (req, auteur) => auteur.id === req.soignant.id || ROLES_GESTION.includes(req.soignant.role);

async function trouver(id) {
  const a = mongoose.isValidObjectId(id) && await Article.findById(id);
  if (!a) throw erreur(404, 'Article introuvable.');
  return a;
}

function trouverCommentaire(article, id) {
  const c = mongoose.isValidObjectId(id) && article.commentaires.id(id);
  if (!c) throw erreur(404, 'Commentaire introuvable.');
  return c;
}

/** Vue d'un article pour le soignant connecté (j'aime, droits de suppression et de réponse). */
function vue(a, req) {
  const moi = req.soignant.id;
  const chef = ROLES_GESTION.includes(req.soignant.role);
  const json = a.toJSON();
  return {
    ...json,
    jaimes: undefined,
    nbJaimes: a.jaimes.length,
    jAime: a.jaimes.includes(moi),
    peutSupprimer: chef || a.auteur.id === moi,
    peutRepondre: a.auteur.id === moi,
    commentaires: json.commentaires.map((c) => ({
      ...c,
      peutSupprimer: chef || c.auteur.id === moi,
      reponses: c.reponses.map((r) => ({ ...r, peutSupprimer: chef || r.auteur.id === moi })),
    })),
  };
}

/** Fil des articles, du plus récent au plus ancien (tous les médecins voient toutes les publications). */
exports.lister = async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const parPage = Math.min(PAR_PAGE_MAX, Math.max(1, parseInt(req.query.parPage, 10) || 10));
  const filtre = Article.CIBLES.includes(req.query.cible) ? { cible: req.query.cible } : {};
  const [total, articles] = await Promise.all([
    Article.countDocuments(filtre),
    Article.find(filtre).sort({ createdAt: -1 }).skip((page - 1) * parPage).limit(parPage),
  ]);
  res.json({ total, page, parPage, articles: articles.map((a) => vue(a, req)) });
};

exports.obtenir = async (req, res) => {
  res.json(vue(await trouver(req.params.id), req));
};

/** Publication multipart : titre, contenu, cible + champ « medias » (4 photos max ou 1 vidéo). */
exports.creer = async (req, res) => {
  const fichiers = req.files || [];
  const titre = texte(req.body?.titre, 200);
  const contenu = texte(req.body?.contenu, 20000);
  if (!titre || !contenu) throw erreur(400, 'Le titre et le contenu de l’article sont obligatoires.');
  const videos = fichiers.filter((f) => f.mimetype.startsWith('video/'));
  if (videos.length && fichiers.length > 1) throw erreur(400, 'Une vidéo se publie seule : retirez les photos ou la vidéo.');
  if (fichiers.length > Article.PHOTOS_MAX) throw erreur(400, `${Article.PHOTOS_MAX} photos au maximum par article.`);
  if (fichiers.some((f) => f.mimetype.startsWith('image/') && f.size > IMAGE_TAILLE_MAX)) throw erreur(400, 'Chaque photo doit faire 5 Mo au maximum.');

  const article = new Article({
    titre, contenu,
    cible: Article.CIBLES.includes(req.body?.cible) ? req.body.cible : 'Tous publics',
    auteur: auteurDe(req.soignant),
  });
  await article.validate().catch((err) => {
    throw erreur(400, Object.values(err.errors || {})[0]?.message || 'Données invalides.');
  });

  // Médias envoyés après la validation ; retirés de R2 si l'enregistrement échoue.
  const envoyes = [];
  try {
    for (const f of fichiers) {
      const { cle, url } = await envoyerFichier(f, DOSSIER_MEDIAS);
      envoyes.push({ type: f.mimetype.startsWith('video/') ? 'video' : 'image', cle, url });
    }
    article.medias = envoyes;
    await article.save();
  } catch (err) {
    await Promise.all(envoyes.map((m) => supprimerFichier(m.cle).catch(() => {})));
    throw err;
  }
  await journaliser(req, { action: 'article.publication', ressource: { type: 'article', id: article.id } });
  res.status(201).json(vue(article, req));
};

/** Texte de l'article : modifiable par son auteur seulement. */
exports.modifier = async (req, res) => {
  const article = await trouver(req.params.id);
  if (article.auteur.id !== req.soignant.id) throw erreur(403, 'Seul l’auteur peut modifier cet article.');
  if (req.body?.titre !== undefined) article.titre = texte(req.body.titre, 200);
  if (req.body?.contenu !== undefined) article.contenu = texte(req.body.contenu, 20000);
  if (Article.CIBLES.includes(req.body?.cible)) article.cible = req.body.cible;
  await article.save().catch((err) => {
    throw erreur(400, Object.values(err.errors || {})[0]?.message || 'Données invalides.');
  });
  res.json(vue(article, req));
};

exports.supprimer = async (req, res) => {
  const article = await trouver(req.params.id);
  if (!peutSupprimer(req, article.auteur)) throw erreur(403, 'Vous ne pouvez supprimer que vos propres publications.');
  await article.deleteOne();
  await Promise.all(article.medias.map((m) => supprimerFichier(m.cle).catch((err) => console.error(`Média ${m.cle} non supprimé de R2 :`, err.message))));
  await journaliser(req, {
    action: 'article.suppression', ressource: { type: 'article', id: article.id },
    details: { auteur: article.auteur.id, parAuteur: article.auteur.id === req.soignant.id },
  });
  res.status(204).end();
};

/** J'aime / je n'aime plus (bascule). */
exports.aimer = async (req, res) => {
  const moi = req.soignant.id;
  const article = await trouver(req.params.id);
  const filtre = { _id: article._id };
  await Article.updateOne(filtre, article.jaimes.includes(moi) ? { $pull: { jaimes: moi } } : { $addToSet: { jaimes: moi } });
  res.json(vue(await trouver(req.params.id), req));
};

exports.commenter = async (req, res) => {
  const t = texte(req.body?.texte, 2000);
  if (!t) throw erreur(400, 'Le commentaire est vide.');
  const article = await trouver(req.params.id);
  article.commentaires.push({ auteur: auteurDe(req.soignant), texte: t, le: new Date() });
  await article.save();
  res.status(201).json(vue(article, req));
};

exports.supprimerCommentaire = async (req, res) => {
  const article = await trouver(req.params.id);
  const c = trouverCommentaire(article, req.params.cid);
  if (!peutSupprimer(req, c.auteur)) throw erreur(403, 'Vous ne pouvez supprimer que vos propres commentaires.');
  c.deleteOne();
  await article.save();
  await journaliser(req, { action: 'article.commentaire.suppression', ressource: { type: 'article', id: article.id }, details: { auteur: c.auteur.id } });
  res.json(vue(article, req));
};

/** Seul le médecin auteur de l'article répond aux commentaires. */
exports.repondre = async (req, res) => {
  const t = texte(req.body?.texte, 2000);
  if (!t) throw erreur(400, 'La réponse est vide.');
  const article = await trouver(req.params.id);
  if (article.auteur.id !== req.soignant.id) throw erreur(403, 'Seul le médecin auteur de l’article peut répondre aux commentaires.');
  trouverCommentaire(article, req.params.cid).reponses.push({ auteur: auteurDe(req.soignant), texte: t, le: new Date() });
  await article.save();
  res.status(201).json(vue(article, req));
};

exports.supprimerReponse = async (req, res) => {
  const article = await trouver(req.params.id);
  const c = trouverCommentaire(article, req.params.cid);
  const r = mongoose.isValidObjectId(req.params.rid) && c.reponses.id(req.params.rid);
  if (!r) throw erreur(404, 'Réponse introuvable.');
  if (!peutSupprimer(req, r.auteur)) throw erreur(403, 'Vous ne pouvez supprimer que vos propres réponses.');
  r.deleteOne();
  await article.save();
  await journaliser(req, { action: 'article.commentaire.suppression', ressource: { type: 'article', id: article.id }, details: { auteur: r.auteur.id, reponse: true } });
  res.json(vue(article, req));
};
