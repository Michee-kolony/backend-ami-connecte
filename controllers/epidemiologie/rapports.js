// Sous-fenêtre 9 — Rapports et exportation. Les rapports réutilisent les calculs des sous-fenêtres
// sources (aucune formule contradictoire), sont figés à la génération (données, définitions,
// versions des paramètres) et exportables en PDF, Excel et CSV. Par défaut, seules les données
// validées sont incluses ; aucune donnée nominative n'est exportée.
const path = require('path');
const PDFDocument = require('pdfkit');
const RapportEpi = require('../../models/RapportEpi');
const PopulationReference = require('../../models/PopulationReference');
const CalculCible = require('../../models/CalculCible');
const PlanCible = require('../../models/PlanCible');
const AlerteEpi = require('../../models/AlerteEpi');
const CoefficientDemographique = require('../../models/CoefficientDemographique');
const { enregistrerNumerote } = require('../../models/validationEpi');
const epi = require('../../config/epidemiologie');
const moteur = require('../../config/moteurEpidemiologie');
const { erreur, texte, objet } = require('../saisie');
const c = require('./commun');
const { calculCouvertures } = require('./couvertures');
const { calculTableau: tableauSurveillance } = require('./surveillance');
const { calculAnalyse } = require('./morbiMortalite');
const { calculTableau: tableauAlertes } = require('./alertes');
const { suiviPlan } = require('./planification');
const { fichesIndicateurs } = require('./parametres');

const nb = (v) => (v == null ? 'N/C' : typeof v === 'number' ? Number(v).toLocaleString('fr-FR') : v);
const pct = (v) => (v == null ? 'Non calculable' : `${String(v).replace('.', ',')} %`);

/** Sections du rapport selon son type (chaque fonction réutilise le calcul de sa sous-fenêtre). */
async function construire(req, type, { du, au, entite, inclureNonValidees }) {
  const sections = [];
  const definitions = [];
  const limites = [];
  const versions = {};
  const annee = Number(du.slice(0, 4));
  const descendants = await c.descendants(entite.code);
  const codes = descendants.map((e) => e.code);
  const nomDe = new Map(descendants.map((e) => [e.code, e]));
  const statuts = inclureNonValidees ? { $nin: ['Archivé', 'Rejeté'] } : 'Validé';
  if (inclureNonValidees) limites.push('Ce rapport inclut des données NON VALIDÉES : il ne constitue pas une consolidation officielle.');

  if (['demographique', 'synthese'].includes(type)) {
    const pops = await PopulationReference.find({ entiteCode: { $in: codes }, annee, statut: statuts }).sort({ version: -1 });
    const vus = new Set();
    const lignes = [];
    for (const p of pops) {
      if (vus.has(p.entiteCode)) continue;
      vus.add(p.entiteCode);
      const e = nomDe.get(p.entiteCode);
      lignes.push([p.entiteCode, e?.nom ?? p.entiteCode, e?.niveau ?? '', p.totale, p.hommes, p.femmes, p.annee, p.nature, p.source, `v${p.version}`, p.statut]);
    }
    sections.push({ titre: `Populations de référence ${annee}`, colonnes: ['Code', 'Territoire', 'Niveau', 'Population totale', 'Hommes', 'Femmes', 'Année', 'Nature', 'Source', 'Version', 'Statut'], lignes,
      notes: ['Les populations de niveaux différents ne sont pas additionnées (risque de double comptage).'] });
    const racine = pops.find((p) => p.entiteCode === entite.code);
    if (racine?.tranchesAge.length) sections.push({ titre: `Répartition par âge — ${entite.nom}`, colonnes: ['Tranche d’âge', 'Effectif', 'Part (%)'],
      lignes: racine.tranchesAge.map((t) => [t.libelle, t.effectif, moteur.ratio(t.effectif, racine.totale).valeur]) });
    versions.populations = lignes.map((l) => `${l[0]} ${l[9]}`);
  }
  if (['cibles', 'synthese'].includes(type)) {
    const calculs = await CalculCible.find({ entiteCode: { $in: codes }, annee, statut: statuts, simulation: false }).sort({ version: -1 });
    const vus = new Set();
    const lignes = [];
    for (const k of calculs) {
      if (vus.has(k.entiteCode)) continue;
      vus.add(k.entiteCode);
      lignes.push([k.entiteCode, nomDe.get(k.entiteCode)?.nom ?? k.entiteCode, k.population.totale, k.cible('FE'), k.cible('NA'), k.cible('NS'), k.numero, `v${k.version}`, k.statut]);
    }
    sections.push({ titre: `Populations cibles ${annee}`, colonnes: ['Code', 'Territoire', 'Population totale', 'Femmes enceintes', 'Naissances attendues', 'Nourrissons survivants', 'Calcul', 'Version', 'Statut'], lignes,
      notes: [`Arrondi : ${epi.ARRONDI}.`, 'Cible = population de référence validée × coefficient validé applicable.'] });
    const coefs = await CoefficientDemographique.find({ statut: 'Validé' }).lean();
    for (const x of coefs) definitions.push({ code: x.code, libelle: `${x.nom} (v${x.version})`, formule: `Population totale × ${String(x.valeurPct).replace('.', ',')} % — source : ${x.source || 'non précisée'}` });
    versions.calculs = lignes.map((l) => `${l[6]} ${l[7]}`);
    versions.coefficients = coefs.map((x) => `${x.code} v${x.version}`);
  }
  if (type === 'planification') {
    const plans = await PlanCible.find({ entiteCode: { $in: codes }, annee, statut: statuts }).sort({ version: -1 });
    const vus = new Set();
    const lignes = [];
    for (const p of plans) {
      if (vus.has(p.numero)) continue;
      vus.add(p.numero);
      const s = await suiviPlan(req, p);
      lignes.push([p.numero, epi.PAR_INTERVENTION.get(p.intervention)?.libelle ?? p.intervention, nomDe.get(p.entiteCode)?.nom ?? p.entiteCode, p.cibleAnnuelle,
        ...p.trimestriel, s.realisationsCumulees, pct(s.tauxAnnuel), s.cibleRestante, p.ajustee ? 'Révisée' : 'Planifiée', p.statut]);
    }
    sections.push({ titre: `Plans ${annee} et état d’exécution`, colonnes: ['Plan', 'Intervention', 'Territoire', 'Cible annuelle', 'T1', 'T2', 'T3', 'T4', 'Réalisations', 'Taux', 'Restante', 'Type de cible', 'Statut'], lignes,
      notes: ['Taux de réalisation = réalisations ÷ cible × 100 ; cible restante = max(0, cible − réalisations cumulées). Une cible n’est pas une réalisation.'] });
  }
  if (['couvertures', 'synthese'].includes(type)) {
    const x = await calculCouvertures(req, { entiteCode: entite.code, du, au, mensuel: false });
    if (x.restreint) limites.push('Réalisations limitées à la structure de connexion (périmètre de l’utilisateur).');
    sections.push({ titre: 'Couverture des interventions', colonnes: ['Code', 'Indicateur', 'Réalisations', 'Population cible (période)', 'Couverture', 'Vérification', 'Fiche'],
      lignes: x.indicateurs.map((i) => [i.code, i.nom, i.numerateur, i.denominateur, pct(i.valeur), i.depassement ? '> 100 % : à vérifier' : i.sousSeuil ? 'Sous le seuil' : '', i.ficheValidee ? `validée v${i.ficheVersion}` : 'non validée']) });
    sections.push({ titre: 'Abandons, zéro dose et continuité des soins', colonnes: ['Indicateur', 'Numérateur', 'Dénominateur', 'Valeur'],
      lignes: [...x.abandons, ...x.continuite].map((a) => [a.libelle, a.numerateur, a.denominateur, pct(a.valeur)])
        .concat([['Enfants zéro dose', x.zeroDose.zeroDose, x.zeroDose.enfantsSuivis, pct(x.zeroDose.proportionZeroDose)], ['Enfants sous-vaccinés', x.zeroDose.sousVaccines, x.zeroDose.enfantsSuivis, pct(x.zeroDose.proportionSousVaccines)]]) });
    for (const i of x.indicateurs) definitions.push({ code: i.code, libelle: i.nom, formule: i.formule });
    for (const a of [...x.abandons, ...x.continuite]) definitions.push({ code: a.code, libelle: a.libelle, formule: a.formule });
    if (!x.calcul) limites.push('Aucune population cible validée pour ce territoire et cette année : les couvertures ne sont pas calculables.');
    versions.indicateurs = (await fichesIndicateurs()).map((f) => `${f.code} v${f.version} (${f.statut})`);
    versions.calculCouvertures = x.calcul ? `${x.calcul.numero} v${x.calcul.version}` : null;
  }
  if (['surveillance', 'synthese'].includes(type)) {
    const s = await tableauSurveillance({ dans: entite.code, du, au });
    sections.push({ titre: 'Surveillance — cas par maladie', colonnes: ['Maladie', 'Suspects', 'Probables', 'Confirmés', 'Décès', 'Létalité', 'Période précédente', 'Variation', 'Non validés'],
      lignes: s.maladies.map((m) => [m.libelle, m.suspects, m.probables, m.confirmes, m.deces, pct(m.letalite), m.precedent, m.variation == null ? 'Non calculable' : pct(m.variation), m.nonValides]) });
    sections.push({ titre: 'Surveillance — événements', colonnes: ['Indicateur', 'Valeur'], lignes: [
      ['Événements notifiés', s.resume.evenements], ['Événements actifs', s.resume.evenementsActifs], ['Cas validés', s.resume.casValides], ['Cas confirmés', s.resume.confirmes],
      ['Décès', s.resume.deces], ['Événements prioritaires sans investigation', s.resume.sansInvestigation], ['Délai moyen de notification (jours)', s.resume.delaiMoyenNotificationJours ?? 'N/C'],
    ] });
    definitions.push({ code: 'LETALITE', libelle: 'Létalité', formule: s.formules.letalite }, { code: 'VARIATION', libelle: 'Variation des cas', formule: s.formules.variation });
  }
  if (['morbidite', 'mortalite', 'synthese'].includes(type)) {
    const a = await calculAnalyse(req, { dans: entite.code, du, au });
    if (type !== 'mortalite') {
      sections.push({ titre: 'Principales causes de morbidité (cas validés)', colonnes: ['Diagnostic', 'Cas'], lignes: a.morbidite.principales.map((x) => [x.libelle, x.n]) });
      if (type === 'morbidite') {
        sections.push({ titre: 'Cas par tranche d’âge et par sexe', colonnes: ['Répartition', 'Cas'], lignes: [...a.morbidite.parAge.map((x) => [x.libelle, x.n]), ...a.morbidite.parSexe.map((x) => [`Sexe : ${x.libelle}`, x.n])] });
        sections.push({ titre: 'Fréquences', colonnes: ['Indicateur', 'Cas', 'Population', 'Valeur'], lignes: a.morbidite.frequences.map((f) => [f.libelle, f.numerateur, f.denominateur, f.valeur == null ? 'Non calculable' : nb(f.valeur)]) });
      }
    }
    if (type !== 'morbidite') {
      sections.push({ titre: 'Indicateurs de mortalité (décès validés)', colonnes: ['Indicateur', 'Numérateur', 'Dénominateur', 'Valeur'],
        lignes: a.mortalite.indicateurs.map((i) => [i.libelle, i.numerateur, i.denominateur, i.valeur == null ? `Non calculable (${i.raison})` : nb(i.valeur)]) });
      sections.push({ titre: 'Décès par cause', colonnes: ['Cause initiale', 'Décès'], lignes: a.mortalite.parCause.map((x) => [x.libelle, x.n]) });
      for (const i of a.mortalite.indicateurs.filter((k) => !k.code.startsWith('CAUSE-'))) definitions.push({ code: i.code, libelle: i.libelle, formule: i.formule });
    }
    const inc = a.incompletes;
    limites.push(`Données incomplètes : ${inc.morbiditeNonValidee} cas de morbidité et ${inc.decesNonValides} décès non validés (exclus) ; ${inc.causeIndeterminee} décès de cause indéterminée.`);
    if (inc.populationAbsente) limites.push('Population de référence validée absente : fréquences et taux de mortalité générale non calculables.');
  }
  if (['alertes', 'synthese'].includes(type)) {
    const t = await tableauAlertes({ dans: entite.code, du, au });
    sections.push({ titre: 'Alertes et insuffisances', colonnes: ['Indicateur', 'Valeur'], lignes: [
      ['Alertes générées', t.total], ['Alertes non traitées (ouvertes)', t.ouvertes], ['Alertes en retard', t.enRetard], ['Taux de résolution', pct(t.tauxResolution.valeur)],
      ['Délai moyen de traitement (jours)', t.delaiMoyenTraitementJours ?? 'N/C'], ...t.parPriorite.map((p) => [`Priorité ${p.libelle}`, p.n]),
    ] });
    if (type === 'alertes') {
      const liste = await AlerteEpi.find({ entiteCode: { $in: codes }, createdAt: { $gte: moteur.instantJour(du), $lt: new Date(moteur.instantJour(au).getTime() + 86400000) } }).sort({ createdAt: -1 }).limit(500).lean();
      sections.push({ titre: 'Actions correctives', colonnes: ['N°', 'Alerte', 'Territoire', 'Priorité', 'Responsable', 'Échéance', 'Action corrective', 'Résultat', 'Statut'],
        lignes: liste.map((a) => [a.numero, a.titre, a.territoire, a.priorite, a.responsable?.nom ?? '', a.echeance ?? '', a.actionCorrective, a.resultat, a.statut]) });
    }
    definitions.push({ code: 'RESOLUTION', libelle: 'Taux de résolution des alertes', formule: t.tauxResolution.formule });
  }
  if (!sections.length) throw erreur(400, 'Type de rapport inconnu.');
  return { sections, definitions, limites, versions };
}

exports.generer = async (req, res) => {
  await c.exiger(req, epi.ROLES_PLANIFICATION, 'Génération réservée aux épidémiologistes et responsables.');
  const d = objet(req.body);
  const type = texte(d.type, 30);
  if (!epi.TYPES_RAPPORT[type]) throw erreur(400, 'Type de rapport invalide.');
  const p = c.periode(d);
  const entite = await c.entite(d.entiteCode || await c.entiteParDefaut(req));
  const inclureNonValidees = d.inclureNonValidees === true;
  const contenu = await construire(req, type, { du: p.du, au: p.au, entite, inclureNonValidees });
  const periodicite = texte(d.periodicite, 20) || (d.mois ? 'Mensuel' : d.trimestre ? 'Trimestriel' : d.annee ? 'Annuel' : 'Personnalisé');
  const rapport = new RapportEpi({
    type, titre: texte(d.titre, 200) || `${epi.TYPES_RAPPORT[type]} — ${entite.nom} — ${p.libelle}`,
    parametres: { du: p.du, au: p.au, entiteCode: entite.code, territoire: entite.nom, niveau: entite.niveau, inclureNonValidees, periodicite,
      indicateurs: Array.isArray(d.indicateurs) ? d.indicateurs.map((x) => texte(x, 30)).slice(0, 50) : [],
      desagregation: Array.isArray(d.desagregation) ? d.desagregation.filter((x) => epi.DESAGREGATIONS.includes(x)) : [] },
    contenu: { sections: contenu.sections, definitions: contenu.definitions, limites: contenu.limites },
    versions: contenu.versions,
    sourceDonnees: 'AMI Santé Connect — module Épidémiologie et modules opérationnels (CPN, accouchement, nouveau-né, vaccination)',
    statutDonnees: inclureNonValidees ? 'Validées et non validées (non officiel)' : 'Validées uniquement',
    commentaire: texte(d.commentaire, 2000), generePar: c.auteur(req),
  });
  await enregistrerNumerote(rapport, `RAP-${new Date().getFullYear()}`);
  await c.tracer(req, 'epi.rapport', { type: 'rapport', id: rapport.numero }, { operation: 'génération', type });
  res.status(201).json(rapport);
};

async function trouver(numero) {
  const r = await RapportEpi.findOne({ numero: texte(numero, 30) });
  if (!r) throw erreur(404, 'Rapport introuvable.');
  return r;
}

exports.lister = async (req, res) => {
  const f = {};
  if (req.query.type) f.type = texte(req.query.type, 30);
  if (req.query.statut) f.statut = texte(req.query.statut, 20);
  const liste = await RapportEpi.find(f).select('-contenu').sort({ createdAt: -1 }).limit(500);
  res.json(liste);
};

exports.obtenir = async (req, res) => res.json(await trouver(req.params.numero));

/** Régénérer : nouvelle version intégrant les corrections validées, l'ancienne est « Remplacé ». */
exports.regenerer = async (req, res) => {
  await c.exiger(req, epi.ROLES_PLANIFICATION, 'Génération réservée aux épidémiologistes et responsables.');
  const ancien = await trouver(req.params.numero);
  const entite = await c.entite(ancien.parametres.entiteCode);
  const contenu = await construire(req, ancien.type, { du: ancien.parametres.du, au: ancien.parametres.au, entite, inclureNonValidees: ancien.parametres.inclureNonValidees });
  const nouveau = new RapportEpi({
    type: ancien.type, titre: ancien.titre, parametres: ancien.parametres.toObject(), contenu: { sections: contenu.sections, definitions: contenu.definitions, limites: contenu.limites },
    versions: contenu.versions, sourceDonnees: ancien.sourceDonnees, statutDonnees: ancien.statutDonnees, commentaire: ancien.commentaire,
    version: ancien.version + 1, regenereDe: ancien.numero, generePar: c.auteur(req),
  });
  await enregistrerNumerote(nouveau, `RAP-${new Date().getFullYear()}`);
  ancien.statut = 'Remplacé';
  ancien.remplacePar = nouveau.numero;
  await ancien.save();
  await c.tracer(req, 'epi.rapport', { type: 'rapport', id: nouveau.numero }, { operation: 'régénération', remplace: ancien.numero });
  res.status(201).json(nouveau);
};

/** Validation d'un rapport officiel (nom et fonction du responsable de validation). */
exports.valider = async (req, res) => {
  await c.exigerValidation(req);
  const r = await trouver(req.params.numero);
  if (r.statut === 'Remplacé') throw erreur(409, 'Rapport remplacé par une version plus récente.');
  if (r.parametres.inclureNonValidees) throw erreur(409, 'Un rapport incluant des données non validées ne peut pas être validé comme rapport officiel.');
  if (r.generePar.id === req.soignant.id && epi.SEPARATION_SAISIE_VALIDATION) throw erreur(403, 'Séparation des rôles : la personne qui a généré le rapport ne peut pas le valider.');
  const d = objet(req.body);
  r.validation = { responsable: texte(d.responsable, 160) || `${req.soignant.prenom} ${req.soignant.nom}`, fonction: texte(d.fonction, 160) || req.soignant.role, par: c.auteur(req), le: new Date() };
  r.statut = 'Validé';
  await r.save();
  await c.tracer(req, 'epi.rapport', { type: 'rapport', id: r.numero }, { operation: 'validation' });
  res.json(r);
};

// --- Exports -----------------------------------------------------------------------------------

const enTete = (r) => [
  ['AMI Santé Connect — Module Épidémiologie'], [r.titre], [`Niveau géographique : ${r.parametres.territoire} (${r.parametres.niveau})`],
  [`Période couverte : du ${r.parametres.du} au ${r.parametres.au}`], [`Date de génération : ${r.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC — par ${r.generePar.nom}`],
  [`Source des données : ${r.sourceDonnees}`], [`Statut de validation : ${r.statut}${r.validation ? ` — ${r.validation.responsable}, ${r.validation.fonction}` : ''} — données : ${r.statutDonnees}`],
  [`Rapport ${r.numero} — version ${r.version}`],
];

function csv(r) {
  const cellule = (v) => {
    const s = v == null ? '' : String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lignes = [...enTete(r), []];
  for (const s of r.contenu.sections) {
    lignes.push([s.titre], s.colonnes, ...s.lignes, ...(s.notes ?? []).map((n) => [`Note : ${n}`]), []);
  }
  lignes.push(['Définitions des indicateurs'], ['Code', 'Indicateur', 'Méthode de calcul'], ...r.contenu.definitions.map((d) => [d.code, d.libelle, d.formule]), []);
  lignes.push(['Commentaires et limites des données'], ...r.contenu.limites.map((l) => [l]), ...(r.commentaire ? [[r.commentaire]] : []));
  return `\uFEFF${lignes.map((l) => l.map(cellule).join(';')).join('\r\n')}`;
}

/** Classeur Excel (SpreadsheetML 2003, ouvert par Excel et LibreOffice) : une feuille par section. */
function excel(r) {
  const x = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const cellule = (v, style = '') => (typeof v === 'number'
    ? `<Cell${style}><Data ss:Type="Number">${v}</Data></Cell>` : `<Cell${style}><Data ss:Type="String">${x(v)}</Data></Cell>`);
  const ligne = (l, style) => `<Row>${l.map((v) => cellule(v, style)).join('')}</Row>`;
  const feuilles = [];
  const nomFeuille = (t, i) => x(`${i + 1}. ${t}`.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  feuilles.push(`<Worksheet ss:Name="Rapport"><Table>${enTete(r).map((l) => ligne(l)).join('')}<Row/>${ligne(['Commentaires et limites'], ' ss:StyleID="t"')}${r.contenu.limites.map((l) => ligne([l])).join('')}</Table></Worksheet>`);
  r.contenu.sections.forEach((s, i) => {
    feuilles.push(`<Worksheet ss:Name="${nomFeuille(s.titre, i)}"><Table>${ligne([s.titre], ' ss:StyleID="t"')}${ligne(s.colonnes, ' ss:StyleID="h"')}${s.lignes.map((l) => ligne(l)).join('')}${(s.notes ?? []).map((n) => ligne([`Note : ${n}`])).join('')}</Table></Worksheet>`);
  });
  feuilles.push(`<Worksheet ss:Name="Définitions"><Table>${ligne(['Code', 'Indicateur', 'Méthode de calcul'], ' ss:StyleID="h"')}${r.contenu.definitions.map((d) => ligne([d.code, d.libelle, d.formule])).join('')}</Table></Worksheet>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">`
    + '<Styles><Style ss:ID="t"><Font ss:Bold="1" ss:Size="12"/></Style><Style ss:ID="h"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1F3A5F" ss:Pattern="Solid"/></Style></Styles>'
    + `${feuilles.join('')}</Workbook>`;
}

/** Caractères hors de la police standard du PDF (WinAnsi) remplacés par un équivalent lisible. */
const pdfTexte = (v) => String(v ?? '').replace(/→/g, '->').replace(/≠/g, '<>').replace(/[−–]/g, '-').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/[^\x00-\xFF’‘“”…–—•œŒ€]/g, '?');

function pdf(r, res) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, info: { Title: pdfTexte(r.titre), Author: 'AMI Santé Connect', Subject: 'Module Épidémiologie' } });
  doc.pipe(res);
  const largeur = doc.page.width - 72;
  try { doc.image(path.join(__dirname, '../../assets/logo-icon.png'), 36, 30, { width: 40 }); } catch { /* logo absent : rapport sans logo */ }
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#1F3A5F').text('AMI SANTÉ CONNECT — Module Épidémiologie', 86, 34);
  doc.fontSize(12).fillColor('#0F766E').text(pdfTexte(r.titre), 86, 52, { width: largeur - 50 });
  doc.moveDown(0.5).font('Helvetica').fontSize(8.5).fillColor('#333333');
  for (const [l] of enTete(r).slice(2)) doc.text(pdfTexte(l), 36);
  doc.moveDown(0.8);
  const tableau = (s) => {
    if (doc.y > doc.page.height - 120) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#1F3A5F').text(pdfTexte(s.titre), 36);
    doc.moveDown(0.3);
    const n = s.colonnes.length;
    const w = largeur / n;
    const rangee = (cellules, entete) => {
      const hauteur = Math.max(14, ...cellules.map((v) => doc.font(entete ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5).heightOfString(pdfTexte(v), { width: w - 6 }) + 6));
      if (doc.y + hauteur > doc.page.height - 40) { doc.addPage(); }
      const y = doc.y;
      if (entete) doc.rect(36, y, largeur, hauteur).fill('#1F3A5F');
      cellules.forEach((v, i) => {
        doc.font(entete ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5).fillColor(entete ? '#FFFFFF' : '#222222')
          .text(pdfTexte(typeof v === 'number' ? nb(v) : v), 36 + i * w + 3, y + 3, { width: w - 6 });
      });
      doc.moveTo(36, y + hauteur).lineTo(36 + largeur, y + hauteur).lineWidth(0.3).strokeColor('#BBBBBB').stroke();
      doc.x = 36;
      doc.y = y + hauteur;
    };
    rangee(s.colonnes, true);
    if (!s.lignes.length) rangee(['Aucune donnée', ...Array(n - 1).fill('')]);
    for (const l of s.lignes) rangee(l);
    for (const note of s.notes ?? []) doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#555555').text(pdfTexte(`Note : ${note}`), 36, doc.y + 2, { width: largeur });
    doc.moveDown(1);
  };
  for (const s of r.contenu.sections) tableau(s);
  if (r.contenu.definitions.length) tableau({ titre: 'Définitions des indicateurs et méthodes de calcul', colonnes: ['Code', 'Indicateur', 'Méthode de calcul'], lignes: r.contenu.definitions.map((d) => [d.code, d.libelle, d.formule]) });
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1F3A5F').text('Commentaires et limites des données', 36);
  doc.font('Helvetica').fontSize(8.5).fillColor('#333333');
  for (const l of [...r.contenu.limites, ...(r.commentaire ? [r.commentaire] : [])]) doc.text(pdfTexte(`• ${l}`), 36, doc.y, { width: largeur });
  if (r.validation) doc.moveDown().font('Helvetica-Bold').text(pdfTexte(`Validé par ${r.validation.responsable}, ${r.validation.fonction}, le ${r.validation.le.toISOString().slice(0, 10)}`), 36);
  doc.end();
}

exports.exporter = async (req, res) => {
  const r = await trouver(req.params.numero);
  const format = texte(req.query.format, 10).toLowerCase();
  const nom = `${r.numero}-v${r.version}`;
  r.exports.push({ format, par: c.auteur(req), le: new Date() });
  await r.save();
  await c.tracer(req, 'epi.rapport.export', { type: 'rapport', id: r.numero }, { format });
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nom}.csv"`);
    return res.send(csv(r));
  }
  if (format === 'excel' || format === 'xls') {
    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nom}.xls"`);
    return res.send(excel(r));
  }
  if (format === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nom}.pdf"`);
    return pdf(r, res);
  }
  throw erreur(400, 'Format invalide (pdf, excel ou csv).');
};

/** Graphiques de la bibliothèque (§9.7) : rapports par catégorie et par mois. */
exports.statistiques = async (req, res) => {
  const liste = await RapportEpi.find().select('type statut createdAt').lean();
  const parType = Object.entries(epi.TYPES_RAPPORT).map(([type, libelle]) => ({ type, libelle, n: liste.filter((r) => r.type === type).length }));
  const parMois = new Map();
  for (const r of liste) { const k = moteur.jourKinshasa(r.createdAt).slice(0, 7); parMois.set(k, (parMois.get(k) ?? 0) + 1); }
  res.json({ total: liste.length, valides: liste.filter((r) => r.statut === 'Validé').length, parType, parMois: [...parMois.entries()].sort().map(([mois, n]) => ({ mois, n })) });
};

