const mongoose = require('mongoose');
const Article = require('../models/Article');
const { auteurDe } = require('../models/commun');
const { ROLES_GESTION } = require('../models/Soignant');
const { journaliser } = require('../config/audit');
const notifications = require('../config/notifications');
const { envoyerFichier, supprimerFichier, urlSignee } = require('../config/r2');
const Soignant = require('../models/Soignant');
const { messageValidation } = require('../config/erreursFr');

const DOSSIER_MEDIAS = 'articles';
const PAR_PAGE_MAX = 30;
const IMAGE_TAILLE_MAX = 5 * 1024 * 1024;

const erreur = (status, message) => Object.assign(new Error(message), { status });
const texte = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));

/** Patientes concernées par un article selon son public (dossiers archivés exclus). */
const PATIENTES_CIBLES = {
  'Grossesse (CPN)': { statut: 'Suivi prénatal' },
  'Après l’accouchement': { statut: { $in: ['Grossesse terminée', 'Suivi postnatal'] } },
  'Tous publics': { statut: { $ne: 'Archivé' } },
};

/**
 * Article devenu visible des patientes : notification push à celles qu'il concerne (sans attendre),
 * avec sa première photo, sinon la photo du médecin auteur.
 */
async function annoncer(article) {
  const photo = article.medias.find((m) => m.type === 'image')?.url
    ?? await notifications.photoNotification(await Soignant.findById(article.auteur.id).select('photo photoCle').catch(() => null));
  await notifications.notifierPatientes(PATIENTES_CIBLES[article.cible] ?? PATIENTES_CIBLES['Tous publics'], {
    titre: `Nouveau conseil du Dr ${article.auteur.nom}`.trim(),
    corps: article.titre,
    donnees: { type: 'article', articleId: article.id },
    image: photo,
  });
}

/** Médecin chef : approuve et supprime les articles, supprime tout commentaire. */
const estChef = (req) => ROLES_GESTION.includes(req.soignant.role);

/** Commentaires et réponses : leur auteur, ou le médecin chef. */
const peutSupprimer = (req, auteur) => auteur.id === req.soignant.id || estChef(req);

/** Articles visibles : les approuvés ; en attente, seulement pour leur auteur et le médecin chef. */
const visibles = (req) => (estChef(req) ? {} : { $or: [{ statut: { $ne: 'En attente' } }, { 'auteur.id': req.soignant.id }] });

async function trouver(id, req) {
  const a = mongoose.isValidObjectId(id) && await Article.findById(id);
  if (!a || (a.enAttente && !estChef(req) && a.auteur.id !== req.soignant.id)) throw erreur(404, 'Article introuvable.');
  return a;
}

/** J'aime, commentaires et réponses : seulement une fois l'article approuvé. */
function exigerApprouve(article) {
  if (article.enAttente) throw erreur(409, 'Article en attente d’approbation par le médecin chef.');
}

function trouverCommentaire(article, id) {
  const c = mongoose.isValidObjectId(id) && article.commentaires.id(id);
  if (!c) throw erreur(404, 'Commentaire introuvable.');
  return c;
}

/** Photos (URL signées) des médecins auteurs des articles, par identifiant. */
async function photosAuteurs(articles) {
  const ids = [...new Set(articles.map((a) => a.auteur.id))].filter((id) => mongoose.isValidObjectId(id));
  const soignants = await Soignant.find({ _id: { $in: ids } }).select('+photoCle photo');
  return new Map(await Promise.all(soignants.map(async (s) => [s.id, (await urlSignee(s.photoCle)) ?? s.photo ?? null])));
}

/** Vue d'un article pour le soignant connecté (photo de l'auteur, j'aime, droits de suppression et de réponse). */
async function vue(a, req, photos) {
  const moi = req.soignant.id;
  const chef = estChef(req);
  const json = a.toJSON();
  photos ??= await photosAuteurs([a]);
  return {
    ...json,
    auteur: { ...json.auteur, photoUrl: photos.get(a.auteur.id) ?? null },
    statut: a.statut ?? 'Approuvé',
    jaimes: undefined,
    nbJaimes: a.jaimes.length,
    jAime: a.jaimes.includes(moi),
    peutSupprimer: chef,
    peutApprouver: chef && a.enAttente,
    peutRepondre: a.auteur.id === moi && !a.enAttente,
    commentaires: json.commentaires.map((c) => ({
      ...c,
      peutSupprimer: chef || c.auteur.id === moi,
      reponses: c.reponses.map((r) => ({ ...r, peutSupprimer: chef || r.auteur.id === moi })),
    })),
  };
}

/**
 * Fil des articles, du plus récent au plus ancien : tous les médecins voient les articles approuvés,
 * plus leurs propres articles en attente. ?statut=En attente : file d'approbation (médecin chef).
 */
exports.lister = async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const parPage = Math.min(PAR_PAGE_MAX, Math.max(1, parseInt(req.query.parPage, 10) || 10));
  const filtre = { ...visibles(req) };
  if (Article.CIBLES.includes(req.query.cible)) filtre.cible = req.query.cible;
  if (req.query.statut === 'En attente') filtre.statut = 'En attente';
  const [total, articles, enAttente] = await Promise.all([
    Article.countDocuments(filtre),
    Article.find(filtre).sort({ createdAt: -1 }).skip((page - 1) * parPage).limit(parPage),
    estChef(req) ? Article.countDocuments({ statut: 'En attente' }) : null,
  ]);
  const photos = await photosAuteurs(articles);
  res.json({ total, page, parPage, enAttente, articles: await Promise.all(articles.map((a) => vue(a, req, photos))) });
};

exports.obtenir = async (req, res) => {
  res.json(await vue(await trouver(req.params.id, req), req));
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

  // Le médecin chef publie directement ; les autres médecins attendent son approbation.
  const chef = estChef(req);
  const article = new Article({
    titre, contenu,
    cible: Article.CIBLES.includes(req.body?.cible) ? req.body.cible : 'Tous publics',
    auteur: auteurDe(req.soignant),
    statut: chef ? 'Approuvé' : 'En attente',
    approbation: chef ? { par: auteurDe(req.soignant), le: new Date() } : undefined,
  });
  await article.validate().catch((err) => {
    throw erreur(400, messageValidation(err));
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
  await journaliser(req, { action: 'article.publication', ressource: { type: 'article', id: article.id }, details: { statut: article.statut } });
  if (!article.enAttente) annoncer(article).catch(() => {});
  res.status(201).json(await vue(article, req));
};

/** Médecin chef : rend public un article en attente. */
exports.approuver = async (req, res) => {
  if (!estChef(req)) throw erreur(403, 'Seul le médecin chef peut approuver un article.');
  const article = await trouver(req.params.id, req);
  if (!article.enAttente) throw erreur(409, 'Cet article est déjà approuvé.');
  article.statut = 'Approuvé';
  article.approbation = { par: auteurDe(req.soignant), le: new Date() };
  await article.save();
  await journaliser(req, { action: 'article.approbation', ressource: { type: 'article', id: article.id }, details: { auteur: article.auteur.id } });
  annoncer(article).catch(() => {});
  res.json(await vue(article, req));
};

/** Texte de l'article : modifiable par son auteur seulement. */
exports.modifier = async (req, res) => {
  const article = await trouver(req.params.id, req);
  if (article.auteur.id !== req.soignant.id) throw erreur(403, 'Seul l’auteur peut modifier cet article.');
  if (req.body?.titre !== undefined) article.titre = texte(req.body.titre, 200);
  if (req.body?.contenu !== undefined) article.contenu = texte(req.body.contenu, 20000);
  if (Article.CIBLES.includes(req.body?.cible)) article.cible = req.body.cible;
  // Un article approuvé et modifié par un autre médecin que le chef repasse en approbation.
  if (!estChef(req) && !article.enAttente && article.isModified()) {
    article.statut = 'En attente';
    article.approbation = undefined;
  }
  await article.save().catch((err) => {
    throw erreur(400, messageValidation(err));
  });
  res.json(await vue(article, req));
};

/** Médecin chef seulement : l'article et ses photos / sa vidéo (bucket R2) sont supprimés. */
exports.supprimer = async (req, res) => {
  if (!estChef(req)) throw erreur(403, 'Seul le médecin chef peut supprimer un article.');
  const article = await trouver(req.params.id, req);
  await article.deleteOne();
  await Promise.all(article.medias.map((m) => supprimerFichier(m.cle).catch((err) => console.error(`Média ${m.cle} non supprimé de R2 :`, err.message))));
  await journaliser(req, {
    action: 'article.suppression', ressource: { type: 'article', id: article.id },
    details: { auteur: article.auteur.id, statut: article.statut ?? 'Approuvé', medias: article.medias.length },
  });
  res.status(204).end();
};

/** J'aime / je n'aime plus (bascule). */
exports.aimer = async (req, res) => {
  const moi = req.soignant.id;
  const article = await trouver(req.params.id, req);
  exigerApprouve(article);
  const filtre = { _id: article._id };
  await Article.updateOne(filtre, article.jaimes.includes(moi) ? { $pull: { jaimes: moi } } : { $addToSet: { jaimes: moi } });
  res.json(await vue(await trouver(req.params.id, req), req));
};

exports.commenter = async (req, res) => {
  const t = texte(req.body?.texte, 2000);
  if (!t) throw erreur(400, 'Le commentaire est vide.');
  const article = await trouver(req.params.id, req);
  exigerApprouve(article);
  article.commentaires.push({ auteur: auteurDe(req.soignant), texte: t, le: new Date() });
  await article.save();
  res.status(201).json(await vue(article, req));
};

exports.supprimerCommentaire = async (req, res) => {
  const article = await trouver(req.params.id, req);
  const c = trouverCommentaire(article, req.params.cid);
  if (!peutSupprimer(req, c.auteur)) throw erreur(403, 'Vous ne pouvez supprimer que vos propres commentaires.');
  c.deleteOne();
  await article.save();
  await journaliser(req, { action: 'article.commentaire.suppression', ressource: { type: 'article', id: article.id }, details: { auteur: c.auteur.id } });
  res.json(await vue(article, req));
};

/** Seul le médecin auteur de l'article répond aux commentaires. */
exports.repondre = async (req, res) => {
  const t = texte(req.body?.texte, 2000);
  if (!t) throw erreur(400, 'La réponse est vide.');
  const article = await trouver(req.params.id, req);
  exigerApprouve(article);
  if (article.auteur.id !== req.soignant.id) throw erreur(403, 'Seul le médecin auteur de l’article peut répondre aux commentaires.');
  trouverCommentaire(article, req.params.cid).reponses.push({ auteur: auteurDe(req.soignant), texte: t, le: new Date() });
  await article.save();
  res.status(201).json(await vue(article, req));
};

exports.supprimerReponse = async (req, res) => {
  const article = await trouver(req.params.id, req);
  const c = trouverCommentaire(article, req.params.cid);
  const r = mongoose.isValidObjectId(req.params.rid) && c.reponses.id(req.params.rid);
  if (!r) throw erreur(404, 'Réponse introuvable.');
  if (!peutSupprimer(req, r.auteur)) throw erreur(403, 'Vous ne pouvez supprimer que vos propres réponses.');
  r.deleteOne();
  await article.save();
  await journaliser(req, { action: 'article.commentaire.suppression', ressource: { type: 'article', id: article.id }, details: { auteur: r.auteur.id, reponse: true } });
  res.json(await vue(article, req));
};
