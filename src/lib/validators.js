// Validaciones de formato compartidas (RNF-29, RD-014). El servidor siempre valida aunque la app ya lo haga.

// Claves de banco del estándar ABM (tres primeros dígitos de la CLABE).
const BANKS = {
  '002': 'BANAMEX', '006': 'BANCOMEXT', '009': 'BANOBRAS', '012': 'BBVA MÉXICO', '014': 'SANTANDER',
  '019': 'BANJÉRCITO', '021': 'HSBC', '030': 'BAJÍO', '036': 'INBURSA', '042': 'MIFEL', '044': 'SCOTIABANK',
  '058': 'BANREGIO', '059': 'INVEX', '060': 'BANSI', '062': 'AFIRME', '072': 'BANORTE', '106': 'BANK OF AMERICA',
  '113': 'VE POR MÁS', '127': 'BANCO AZTECA', '128': 'AUTOFIN', '130': 'COMPARTAMOS', '136': 'INTERCAM',
  '137': 'BANCOPPEL', '138': 'ABC CAPITAL', '140': 'CONSUBANCO', '143': 'CIBANCO', '145': 'BBASE',
  '147': 'BANKAOOL', '148': 'PAGATODO', '152': 'BANCREA', '154': 'BANCO COVALTO', '155': 'ICBC',
  '156': 'SABADELL', '157': 'SHINHAN', '158': 'MIZUHO', '166': 'BANCO DEL BIENESTAR', '638': 'NU MÉXICO',
  '646': 'STP', '722': 'MERCADO PAGO', '728': 'SPIN BY OXXO',
};

const CLABE_WEIGHTS = [3, 7, 1];

function onlyDigits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

// Dígito verificador: suma de (dígito × peso 3,7,1 mod 10) sobre los primeros 17; DV = (10 − suma mod 10) mod 10.
function isValidClabe(value) {
  const clabe = String(value ?? '').trim();
  if (!/^\d{18}$/.test(clabe)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    sum += (Number(clabe[i]) * CLABE_WEIGHTS[i % 3]) % 10;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(clabe[17]);
}

function bankFromClabe(value) {
  return BANKS[String(value ?? '').slice(0, 3)] || null;
}

function maskClabe(value) {
  const clabe = onlyDigits(value);
  if (clabe.length < 4) return null;
  return `•••• •••• •••• ${clabe.slice(-4)}`;
}

function luhn(value) {
  const digits = onlyDigits(value);
  if (digits.length < 12 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value ?? '').trim());
}

function isStrongPassword(value) {
  const s = String(value ?? '');
  return s.length >= 8 && /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s);
}

function isPhoneMx(value) {
  return /^\d{10}$/.test(onlyDigits(value));
}

module.exports = { isValidClabe, bankFromClabe, maskClabe, luhn, isEmail, isStrongPassword, isPhoneMx, onlyDigits, BANKS };
