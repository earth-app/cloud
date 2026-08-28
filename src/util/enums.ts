// #region visibility
export const VISIBILITY = ['PRIVATE', 'UNLISTED', 'PUBLIC'] as const;

export type Visibility = (typeof VISIBILITY)[number];

// #endregion

// #region account

export const ACCOUNT_TYPE = ['FREE', 'PRO', 'WRITER', 'ORGANIZER', 'ADMINISTRATOR'] as const;

export type AccountType = (typeof ACCOUNT_TYPE)[number];

export const PRIVACY = ['PRIVATE', 'CIRCLE', 'MUTUAL', 'PUBLIC'] as const;

export type Privacy = (typeof PRIVACY)[number];

export const COUNTRY = [
	'INTERNATIONAL',
	'UNITED_STATES',
	'AFGHANISTAN',
	'ALBANIA',
	'ALGERIA',
	'ANDORRA',
	'ANGOLA',
	'ANTIGUA_AND_BARBUDA',
	'ARGENTINA',
	'ARMENIA',
	'AUSTRALIA',
	'AUSTRIA',
	'AZERBAIJAN',
	'BAHAMAS',
	'BAHRAIN',
	'BANGLADESH',
	'BARBADOS',
	'BELARUS',
	'BELGIUM',
	'BELIZE',
	'BENIN',
	'BHUTAN',
	'BOLIVIA',
	'BOSNIA_AND_HERZEGOVINA',
	'BOTSWANA',
	'BRAZIL',
	'BRUNEI',
	'BULGARIA',
	'BURKINA_FASO',
	'BURUNDI',
	'CABO_VERDE',
	'CAMBODIA',
	'CAMEROON',
	'CANADA',
	'CENTRAL_AFRICAN_REPUBLIC',
	'CHAD',
	'CHILE',
	'CHINA',
	'COLOMBIA',
	'COMOROS',
	'CONGO',
	'COSTA_RICA',
	'CROATIA',
	'CUBA',
	'CYPRUS',
	'CZECH_REPUBLIC',
	'DEMOCRATIC_REPUBLIC_OF_THE_CONGO',
	'DENMARK',
	'DJIBOUTI',
	'DOMINICA',
	'DOMINICAN_REPUBLIC',
	'ECUADOR',
	'EGYPT',
	'EL_SALVADOR',
	'EQUATORIAL_GUINEA',
	'ERITREA',
	'ESTONIA',
	'ESWATINI',
	'ETHIOPIA',
	'FIJI',
	'FINLAND',
	'FRANCE',
	'GABON',
	'GAMBIA',
	'GEORGIA',
	'GERMANY',
	'GHANA',
	'GREECE',
	'GRENADA',
	'GUATEMALA',
	'GUINEA',
	'GUINEA_BISSAU',
	'GUYANA',
	'HAITI',
	'HONDURAS',
	'HUNGARY',
	'ICELAND',
	'INDIA',
	'INDONESIA',
	'IRAN',
	'IRAQ',
	'IRELAND',
	'ISRAEL',
	'ITALY',
	'IVORY_COAST',
	'JAMAICA',
	'JAPAN',
	'JORDAN',
	'KAZAKHSTAN',
	'KENYA',
	'KIRIBATI',
	'KUWAIT',
	'KYRGYZSTAN',
	'LAOS',
	'LATVIA',
	'LEBANON',
	'LESOTHO',
	'LIBERIA',
	'LIBYA',
	'LIECHTENSTEIN',
	'LITHUANIA',
	'LUXEMBOURG',
	'MADAGASCAR',
	'MALAWI',
	'MALAYSIA',
	'MALDIVES',
	'MALI',
	'MALTA',
	'MARSHALL_ISLANDS',
	'MAURITANIA',
	'MAURITIUS',
	'MEXICO',
	'MICRONESIA',
	'MOLDOVA',
	'MONACO',
	'MONGOLIA',
	'MONTENEGRO',
	'MOROCCO',
	'MOZAMBIQUE',
	'MYANMAR',
	'NAMIBIA',
	'NAURU',
	'NEPAL',
	'NETHERLANDS',
	'NEW_ZEALAND',
	'NICARAGUA',
	'NIGER',
	'NIGERIA',
	'NORTH_MACEDONIA',
	'NORWAY',
	'OMAN',
	'PAKISTAN',
	'PALAU',
	'PANAMA',
	'PAPUA_NEW_GUINEA',
	'PARAGUAY',
	'PERU',
	'PHILIPPINES',
	'POLAND',
	'PORTUGAL',
	'QATAR',
	'ROMANIA',
	'RUSSIA',
	'RWANDA',
	'SAINT_KITTS_AND_NEVIS',
	'SAINT_LUCIA',
	'SAINT_VINCENT_AND_THE_GRENADINES',
	'SAMOA',
	'SAN_MARINO',
	'SAO_TOME_AND_PRINCIPE',
	'SAUDI_ARABIA',
	'SENEGAL',
	'SERBIA',
	'SEYCHELLES',
	'SIERRA_LEONE',
	'SINGAPORE',
	'SLOVAKIA',
	'SLOVENIA',
	'SOLOMON_ISLANDS',
	'SOMALIA',
	'SOUTH_AFRICA',
	'SOUTH_KOREA',
	'SOUTH_SUDAN',
	'SPAIN',
	'SRI_LANKA',
	'SUDAN',
	'SURINAME',
	'SWEDEN',
	'SWITZERLAND',
	'SYRIA',
	'TAIWAN',
	'TAJIKISTAN',
	'TANZANIA',
	'THAILAND',
	'TIMOR_LESTE',
	'TOGO',
	'TONGA',
	'TRINIDAD_AND_TOBAGO',
	'TUNISIA',
	'TURKEY',
	'TURKMENISTAN',
	'TUVALU',
	'UGANDA',
	'UKRAINE',
	'UNITED_ARAB_EMIRATES',
	'UNITED_KINGDOM',
	'URUGUAY',
	'UZBEKISTAN',
	'VANUATU',
	'VATICAN_CITY',
	'VENEZUELA',
	'VIETNAM',
	'YEMEN',
	'ZAMBIA',
	'ZIMBABWE'
] as const;

export type Country = (typeof COUNTRY)[number];

// #endregion

// #region activity

export const ACTIVITY_TYPE = [
	'HOBBY',
	'SPORT',
	'WORK',
	'STUDY',
	'TRAVEL',
	'SOCIAL',
	'RELAXATION',
	'HEALTH',
	'PROJECT',
	'PERSONAL_GOAL',
	'COMMUNITY_SERVICE',
	'CREATIVE',
	'FAMILY',
	'HOLIDAY',
	'ENTERTAINMENT',
	'LEARNING',
	'NATURE',
	'TECHNOLOGY',
	'ART',
	'SPIRITUALITY',
	'FINANCE',
	'HOME_IMPROVEMENT',
	'PETS',
	'FASHION',
	'OTHER'
] as const;

export type ActivityType = (typeof ACTIVITY_TYPE)[number];

// #endregion

// #region guards

// falls back instead of throwing like ocean's Enum.valueOf did; the backend can add a member
// before the frontend ships, and a throw there takes a page down over an unrecognised string
function coerce<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
	return typeof value === 'string' && (values as readonly string[]).includes(value)
		? (value as T)
		: fallback;
}

export const isVisibility = (v: unknown): v is Visibility =>
	typeof v === 'string' && (VISIBILITY as readonly string[]).includes(v);

export const toVisibility = (v: unknown, fallback: Visibility = 'PUBLIC'): Visibility =>
	coerce(VISIBILITY, v, fallback);

export const isAccountType = (v: unknown): v is AccountType =>
	typeof v === 'string' && (ACCOUNT_TYPE as readonly string[]).includes(v);

export const toAccountType = (v: unknown, fallback: AccountType = 'FREE'): AccountType =>
	coerce(ACCOUNT_TYPE, v, fallback);

export const isPrivacy = (v: unknown): v is Privacy =>
	typeof v === 'string' && (PRIVACY as readonly string[]).includes(v);

export const toPrivacy = (v: unknown, fallback: Privacy = 'PRIVATE'): Privacy =>
	coerce(PRIVACY, v, fallback);

export const isActivityType = (v: unknown): v is ActivityType =>
	typeof v === 'string' && (ACTIVITY_TYPE as readonly string[]).includes(v);

export const toActivityType = (v: unknown, fallback: ActivityType = 'OTHER'): ActivityType =>
	coerce(ACTIVITY_TYPE, v, fallback);

export const isCountry = (v: unknown): v is Country =>
	typeof v === 'string' && (COUNTRY as readonly string[]).includes(v);

export const toCountry = (v: unknown, fallback: Country = 'INTERNATIONAL'): Country =>
	coerce(COUNTRY, v, fallback);

// #endregion
