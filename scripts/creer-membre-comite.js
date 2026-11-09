// Crée un compte du comité de pilotage (propriétaire du projet).
// Usage : node scripts/creer-membre-comite.js <email> <motDePasse> <prenom> <nom> [fonction]
// Le mot de passe doit compter 10 caractères avec majuscule, minuscule, chiffre et caractère spécial.
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');

process.loadEnvFile();
const MembreComite = require('../models/MembreComite');
const { motDePasseValide } = require('../controllers/soignants');

async function main() {
  const [email, motDePasse, prenom, nom, ...fonction] = process.argv.slice(2);
  if (!email || !motDePasse || !prenom || !nom) {
    console.error('Usage : node scripts/creer-membre-comite.js <email> <motDePasse> <prenom> <nom> [fonction]');
    process.exit(1);
  }
  if (!motDePasseValide(motDePasse)) {
    console.error('Mot de passe trop faible (10 caractères, majuscules, minuscules, chiffre et caractère spécial).');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  if (await MembreComite.exists({ email: email.toLowerCase() })) {
    console.error(`Un compte du comité existe déjà pour ${email}.`);
    process.exit(1);
  }
  const m = await MembreComite.create({
    email, prenom, nom, fonction: fonction.join(' '),
    motDePasse: await bcrypt.hash(motDePasse, 12), doitChangerMotDePasse: false,
  });
  console.log(`Membre du comité créé : ${m.prenom} ${m.nom} <${m.email}>`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
