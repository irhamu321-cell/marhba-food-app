/*
 * FAQ and legal pages, in French and Arabic.
 *
 * IMPORTANT — this is a template, not legal advice. The text is written for a
 * cash-on-delivery marketplace operating in Morocco and refers to law 09-08 on
 * the protection of personal data and to the CNDP. Have a Moroccan lawyer read
 * it, and confirm the CNDP declaration requirement, before taking real orders.
 *
 * The business identity is NOT written here. It comes from the server, out of
 * server/config/business.js (or the matching environment variables), so there
 * is exactly one place to fill it in. A value that is still empty is shown as
 * a visible "to be completed" mark rather than quietly omitted.
 */

export const FAQ = {
  fr: [
    { q: 'Comment je paie ma commande ?',
      a: 'En especes uniquement, au moment ou tu recois la commande ou quand tu la recuperes au restaurant. Il n y a pas de paiement par carte pour le moment.' },
    { q: 'Qui livre ma commande ?',
      a: 'Le restaurant lui-meme, avec son propre livreur, quand il propose la livraison. Sinon tu passes la recuperer sur place.' },
    { q: 'Combien de temps avant de recevoir ma commande ?',
      a: 'Chaque restaurant affiche son temps de preparation habituel sur sa page. Ajoute le trajet si tu es en livraison.' },
    { q: 'Je peux annuler ma commande ?',
      a: 'Oui, tant que le restaurant ne l a pas encore acceptee. Des qu elle est acceptee, appelle directement le restaurant : son numero est sur la commande.' },
    { q: 'Comment j utilise un code promo ?',
      a: 'Tape le code dans le panier, avant de commander, et appuie sur Appliquer. La reduction s affiche tout de suite dans le total.' },
    { q: 'Mon code promo ne marche pas, pourquoi ?',
      a: 'Il peut avoir expire, avoir deja ete utilise par toi, demander un montant minimum, ou ne valoir que pour un restaurant precis. Le message t indique la raison exacte.' },
    { q: 'Il manque un plat ou la commande est fausse, je fais quoi ?',
      a: 'Appelle le restaurant en premier, c est le plus rapide. Si ca ne se regle pas, ecris-nous depuis Aide : on te rappelle.' },
    { q: 'Comment je change mon numero ou mon mot de passe ?',
      a: 'Dans Compte : tu peux modifier ton nom, ton numero, ton email et ton mot de passe. Changer le mot de passe deconnecte tous tes autres appareils.' },
    { q: 'Je suis restaurateur, comment je m inscris ?',
      a: 'Ouvre l espace restaurant depuis la page Compte, cree ton espace, prepare ta carte. Ton restaurant devient visible des qu il est valide.' },
  ],
  ar: [
    { q: 'كيف أؤدي ثمن الطلب؟',
      a: 'نقدا فقط، عند استلام الطلب أو عند أخذه من المطعم. الأداء بالبطاقة غير متوفر حاليا.' },
    { q: 'من يوصل الطلب؟',
      a: 'المطعم نفسه بموصله الخاص، إذا كان يوفر التوصيل. وإلا تأخذ الطلب من المحل.' },
    { q: 'كم من الوقت أنتظر؟',
      a: 'كل مطعم يعرض مدة التحضير المعتادة في صفحته. أضف وقت الطريق إذا اخترت التوصيل.' },
    { q: 'هل يمكنني إلغاء الطلب؟',
      a: 'نعم، ما دام المطعم لم يقبله بعد. بعد القبول، اتصل مباشرة بالمطعم: رقمه موجود في الطلب.' },
    { q: 'كيف أستعمل كود التخفيض؟',
      a: 'اكتب الكود في السلة قبل تأكيد الطلب واضغط "تطبيق". يظهر التخفيض فورا في المجموع.' },
    { q: 'لماذا لا يعمل كود التخفيض؟',
      a: 'قد يكون منتهي الصلاحية، أو استعملته من قبل، أو يتطلب مبلغا أدنى، أو يخص مطعما معينا. الرسالة تشرح السبب بالضبط.' },
    { q: 'الطلب ناقص أو خاطئ، ماذا أفعل؟',
      a: 'اتصل بالمطعم أولا، هذا أسرع حل. إن لم تُحل المشكلة، راسلنا من صفحة المساعدة وسنتصل بك.' },
    { q: 'كيف أغير رقمي أو كلمة المرور؟',
      a: 'من صفحة "حسابي": يمكنك تغيير الاسم والرقم والبريد وكلمة المرور. تغيير كلمة المرور يسجل خروجك من باقي الأجهزة.' },
    { q: 'عندي مطعم، كيف أسجل؟',
      a: 'افتح "فضاء المطعم" من صفحة الحساب، أنشئ حسابك وجهز قائمتك. يظهر مطعمك بعد الموافقة عليه.' },
  ],
};


/* ------------------------------------------------------------------ *
 * Legal pages
 * ------------------------------------------------------------------ */

/**
 * A value the operator has not filled in yet. It is shown, loudly, so that an
 * unfinished policy can never be mistaken for a finished one.
 */
const TODO = {
  fr: (label) => `[À COMPLÉTER : ${label}]`,
  ar: (label) => `[يجب إكماله: ${label}]`,
};

/** Reads one business value, or the visible placeholder when it is empty. */
function value(business, key, lang) {
  const found = business?.values?.[key];
  if (found) return found;
  const field = (business?.fields || []).find((f) => f.key === key);
  const label = field ? (lang === 'ar' ? field.labelAr : field.label) : key;
  return TODO[lang === 'ar' ? 'ar' : 'fr'](label);
}

/** The pages, in the order the Help screen lists them. */
export const LEGAL_PAGES = ['about', 'terms', 'privacy', 'cookies', 'cod', 'retention', 'contact'];

/**
 * Builds every legal page for one language from the business identity.
 * Returns { title, sections: [{ heading, paragraphs }] }.
 */
export function buildLegal(business, lang = 'fr') {
  const v = (key) => value(business, key, lang);
  const name = v('BUSINESS_NAME');
  const city = v('BUSINESS_CITY');
  const phone = v('BUSINESS_PHONE');
  const mail = v('BUSINESS_EMAIL');
  const person = v('RESPONSIBLE_PERSON');
  const cndp = business?.values?.CNDP_DECLARATION || '';

  if (lang === 'ar') {
    return {
      about: {
        title: 'من نحن',
        sections: [
          { heading: 'ما هي هذه المنصة', paragraphs: [
            `${name} سوق إلكتروني يربط الزبناء بمطاعم ${city}. نحن لا نطبخ ولا نوصل: كل مطعم يحضر أطباقه ويتكلف بالتوصيل أو بالتسليم في المحل.`,
            'دورنا هو عرض القوائم، ونقل الطلبات، وتتبع تقدمها. الأداء يتم نقدا، مباشرة للمطعم.',
          ] },
          { heading: 'الناشر', paragraphs: [
            `${name}، ${v('LEGAL_FORM')}، السجل التجاري ${v('RC_NUMBER')}، المعرف الموحد ${v('ICE_NUMBER')}.`,
            `المقر: ${v('BUSINESS_ADDRESS')}، ${city}. المسؤول عن النشر: ${person}.`,
            `الاتصال: ${phone} — ${mail}.`,
          ] },
        ],
      },
      terms: {
        title: 'شروط الاستعمال',
        sections: [
          { heading: '1. موضوع الخدمة', paragraphs: [
            `${name} يضع رهن إشارتك منصة لطلب الأكل من مطاعم شريكة. عقد البيع يُبرم بينك وبين المطعم، وليس معنا.`,
          ] },
          { heading: '2. الحساب', paragraphs: [
            'تحتاج رقم هاتف صالح. نرسل لك رمزا للتحقق منه. أنت مسؤول عن سرية كلمة المرور وعن كل طلب يصدر من حسابك.',
            'يمكننا تعليق حساب في حالة استعمال تدليسي أو طلبات وهمية متكررة.',
          ] },
          { heading: '3. الطلب والأثمنة', paragraphs: [
            'الأثمنة معروضة بالدرهم المغربي وتشمل جميع الرسوم المطبقة من طرف المطعم. ثمن التوصيل يُعرض قبل التأكيد.',
            'الطلب يصبح نهائيا بمجرد قبول المطعم له. إلى حدود ذلك يمكنك إلغاؤه من التطبيق.',
          ] },
          { heading: '4. الأداء', paragraphs: [
            'الأداء نقدا فقط، عند الاستلام أو عند أخذ الطلب. لا نقبل البطاقات ولا الأداء الإلكتروني حاليا.',
          ] },
          { heading: '5. مسؤولية المطعم', paragraphs: [
            'جودة الأكل وسلامته ومطابقته للطلب ومدة التحضير من مسؤولية المطعم وحده، وهو الذي يتوفر على التراخيص الصحية اللازمة.',
          ] },
          { heading: '6. مسؤوليتنا', paragraphs: [
            'نلتزم ببذل العناية اللازمة لتشغيل المنصة ونقل الطلبات. لا نتحمل مسؤولية انقطاع مؤقت للخدمة ولا خطأ من المطعم.',
          ] },
          { heading: '7. القانون المطبق', paragraphs: [
            'تخضع هذه الشروط للقانون المغربي. في حالة نزاع، تكون محاكم المدينة المذكورة أعلاه هي المختصة.',
          ] },
        ],
      },
      privacy: {
        title: 'سياسة الخصوصية',
        sections: [
          { heading: 'المسؤول عن المعالجة', paragraphs: [
            `${name}، ${v('BUSINESS_ADDRESS')}، ${city}. المسؤول: ${person}. الاتصال: ${mail}.`,
          ] },
          { heading: 'ما الذي نجمعه ولماذا', paragraphs: [
            'الاسم والهاتف وعنوان التوصيل: لتنفيذ الطلب وتمكين المطعم من الاتصال بك.',
            'البريد الإلكتروني (اختياري): لاسترجاع كلمة المرور.',
            'تاريخ الطلبات: لعرضه لك ولتسوية الحسابات مع المطاعم.',
            'سجل تقني (عنوان IP، نوع المتصفح): لأمن الخدمة واكتشاف الاستعمال المسيء.',
          ] },
          { heading: 'موقعك والنقطة على الخريطة', paragraphs: [
            'عندما تضغط على «استعمال موقعي الحالي»، يرسل متصفحك إحداثياتك مرة واحدة، من أجل توسيط الخريطة في ذلك المكان. يمكنك الرفض: تُفتح الخريطة حينها على وسط المدينة وتضع المؤشر بنفسك.',
            'تُحفظ النقطة التي تؤكدها مع عنوانك، ولهذا الغرض فقط: تحديد عنوان التوصيل وتنفيذ طلباتك.',
            'لا يتم تتبع موقعك بشكل مستمر. نقرأه فقط في اللحظة التي تضغط فيها على ذلك الزر، وليس في الخلفية ولا عندما يكون التطبيق مغلقا.',
            'المطعم الذي يعدّ طلبك يرى هذه النقطة لأنه يحتاجها للتوصيل. ولا تُستعمل للإعلانات ولا لرسم ملف عنك ولا لقياس تحركاتك.',
            'يمكنك تعديل أو حذف أي عنوان، ونقطته، في أي وقت من «عناويني». أما الطلبات السابقة فتحتفظ بالعنوان كما كان وقت الطلب: فهو سجل ما تم توصيله، والمحاسبة تقتضي ذلك.',
          ] },
          { heading: 'من يرى بياناتك', paragraphs: [
            'المطعم الذي طلبت منه يرى اسمك ورقمك وعنوان التوصيل، وهذا ضروري للتسليم.',
            'لا نبيع بياناتك ولا نكريها لأي طرف ثالث.',
          ] },
          { heading: 'مدة الاحتفاظ', paragraphs: [
            'الحساب: ما دام مفتوحا، ثم 12 شهرا بعد آخر نشاط.',
            'الطلبات والفواتير: 10 سنوات، وهي المدة المحاسبية المطلوبة.',
            'السجلات التقنية: 12 شهرا.',
            'رموز التحقق: دقائق معدودة، ثم تُحذف.',
          ] },
          { heading: 'حقوقك (القانون 09-08)', paragraphs: [
            `لك حق الوصول إلى بياناتك وتصحيحها والاعتراض على معالجتها. اكتب إلى ${mail} أو اتصل بـ ${phone}.`,
            'يمكنك أيضا تقديم شكاية لدى اللجنة الوطنية لمراقبة حماية المعطيات ذات الطابع الشخصي (CNDP).',
            cndp
              ? `تصريح CNDP رقم ${cndp}.`
              : 'التصريح لدى CNDP قيد الإنجاز. هذه الصفحة ستُحدَّث بمجرد الحصول على الرقم؛ لا ندّعي أي موافقة مسبقة.',
          ] },
          { heading: 'الأمان', paragraphs: [
            'كلمات المرور محفوظة مشفرة ولا يمكن استرجاعها. رموز التحقق محفوظة مشفرة أيضا وتنتهي صلاحيتها بسرعة.',
          ] },
        ],
      },
      cookies: {
        title: 'ملفات التعريف والتخزين المحلي',
        sections: [
          { heading: 'لا نستعمل ملفات تعريف تتبعية', paragraphs: [
            'لا نضع أي كوكي إعلاني ولا أداة تحليل خارجية. لا يوجد تتبع عبر المواقع.',
          ] },
          { heading: 'ما نخزنه في متصفحك', paragraphs: [
            'رمز الجلسة: ليبقى حسابك مفتوحا. يُحذف عند تسجيل الخروج.',
            'السلة: لكي لا تضيع طلبيتك إذا أغلقت الصفحة.',
            'اللغة المختارة: فرنسية أو عربية.',
            'العنوان المختار: لمعرفة أي عنوان نقترح عليك عند الطلب.',
            'عنوان أدخلته قبل إنشاء حساب: يُحفظ في هذا الجهاز، ثم يُسجّل في حسابك عند أول تسجيل دخول.',
            'كل هذا محفوظ محليا في جهازك فقط، ويمكنك مسحه من إعدادات المتصفح.',
          ] },
          { heading: 'الخريطة تأتي من خدمة خارجية', paragraphs: [
            'عندما تفتح الخريطة لوضع مؤشر، تُحمَّل خلفيات الخريطة من OpenStreetMap، وبرنامج الخريطة من خدمة توزيع عمومية. لذلك ترى هاتان الخدمتان عنوان IP الخاص بك والمنطقة التي تنظر إليها، مثل أي موقع تزوره.',
            'لا نرسل إليهما اسمك ولا رقمك ولا عنوانك. ولا تُفتح الخريطة إلا إذا ضغطت على الزر: إذا كتبت عنوانك يدويا، لا يُرسل أي طلب إليهما.',
          ] },
        ],
      },
      cod: {
        title: 'الأداء نقدا والإرجاع',
        sections: [
          { heading: 'الأداء عند الاستلام', paragraphs: [
            'تؤدي نقدا للمطعم عند استلام الطلب أو عند أخذه. المبلغ المعروض في السلة هو المبلغ النهائي.',
            'ننصح بتحضير المبلغ بالضبط: المطعم غير ملزم بتوفير الصرف.',
          ] },
          { heading: 'الإلغاء', paragraphs: [
            'يمكنك الإلغاء مجانا ما دام المطعم لم يقبل الطلب. بعد القبول، اتصل بالمطعم مباشرة.',
          ] },
          { heading: 'طلب خاطئ أو ناقص', paragraphs: [
            'اتصل بالمطعم أولا. إن لم تُحل المشكلة، راسلنا من صفحة المساعدة خلال 24 ساعة.',
          ] },
          { heading: 'الإرجاع', paragraphs: [
            'بما أن الأداء نقدي، يتم الإرجاع نقدا من طرف المطعم، أو يُخصم من طلب لاحق حسب الاتفاق.',
            'نسجل كل إرجاع في المنصة ونصححه في حساب المطعم. لا نحتفظ بأي مبلغ لك.',
          ] },
        ],
      },
      retention: {
        title: 'الاحتفاظ بالبيانات',
        sections: [
          { heading: 'المبدأ', paragraphs: [
            'نحتفظ بكل نوع من البيانات للمدة الضرورية فقط، ثم نحذفه أو نجعله مجهول الهوية.',
          ] },
          { heading: 'الجدول', paragraphs: [
            'حساب نشط: ما دام مفتوحا.',
            'حساب غير نشط: يُحذف بعد 12 شهرا من آخر اتصال.',
            'الطلبات والمبالغ: 10 سنوات (الالتزام المحاسبي).',
            'رسائل الدعم: 24 شهرا.',
            'سجل العمليات الإدارية: 24 شهرا.',
            'رموز التحقق: من 5 إلى 15 دقيقة.',
            'النسخ الاحتياطية: 14 يوما.',
          ] },
          { heading: 'الحذف', paragraphs: [
            `لطلب حذف حسابك، اكتب إلى ${mail}. نحتفظ بالطلبات السابقة لأنها وثائق محاسبية، لكن نفصلها عن هويتك.`,
          ] },
        ],
      },
      contact: {
        title: 'اتصل بنا',
        sections: [
          { heading: 'للزبناء', paragraphs: [
            `الهاتف: ${phone}`,
            `البريد: ${mail}`,
            'أو من صفحة المساعدة داخل التطبيق: نجيب خلال يوم عمل.',
          ] },
          { heading: 'للمطاعم', paragraphs: [
            `نفس الرقم ونفس البريد. للتسجيل، افتح فضاء المطعم من صفحة الحساب.`,
          ] },
          { heading: 'للمسائل القانونية وحماية المعطيات', paragraphs: [
            `${person} — ${mail}`,
            `${v('BUSINESS_ADDRESS')}، ${city}`,
          ] },
        ],
      },
    };
  }

  return {
    about: {
      title: 'À propos',
      sections: [
        { heading: 'Ce qu’est cette plateforme', paragraphs: [
          `${name} est une place de marché qui met en relation des clients et des restaurants de ${city}. Nous ne cuisinons pas et nous ne livrons pas : chaque restaurant prépare ses plats et assure lui-même la livraison ou la remise sur place.`,
          'Notre rôle est de présenter les cartes, transmettre les commandes et suivre leur avancement. Le paiement se fait en espèces, directement au restaurant.',
        ] },
        { heading: 'Éditeur du service', paragraphs: [
          `${name}, ${v('LEGAL_FORM')}, RC ${v('RC_NUMBER')}, ICE ${v('ICE_NUMBER')}.`,
          `Siège : ${v('BUSINESS_ADDRESS')}, ${city}. Responsable de la publication : ${person}.`,
          `Nous contacter : ${phone} — ${mail}. Tu peux aussi nous écrire depuis la page Aide.`,
        ] },
        { heading: 'Hébergement', paragraphs: [
          'Le service est hébergé sur un serveur loué par l’éditeur. Les coordonnées de l’hébergeur sont communiquées sur demande à l’adresse de contact ci-dessus.',
        ] },
      ],
    },
    terms: {
      title: 'Conditions d’utilisation',
      sections: [
        { heading: '1. Objet', paragraphs: [
          `${name} met à ta disposition une plateforme pour commander à manger auprès de restaurants partenaires. Le contrat de vente se conclut entre toi et le restaurant, pas avec nous.`,
          'En utilisant le service, tu acceptes ces conditions. Si tu ne les acceptes pas, n’utilise pas la plateforme.',
        ] },
        { heading: '2. Ton compte', paragraphs: [
          'Un numéro de téléphone valide est nécessaire. Nous t’envoyons un code pour le vérifier : il prouve que le numéro est bien le tien, ce qui protège les restaurants des fausses commandes.',
          'Tu es responsable de la confidentialité de ton mot de passe et de toute commande passée depuis ton compte.',
          'Nous pouvons suspendre un compte en cas d’usage frauduleux, de fausses commandes répétées ou d’abus envers un restaurant.',
        ] },
        { heading: '3. Commandes et prix', paragraphs: [
          'Les prix sont affichés en dirhams et incluent les taxes applicables par le restaurant. Les frais de livraison, quand il y en a, sont affichés avant la validation.',
          'Le total affiché dans le panier est le montant exact à payer. Il est recalculé par nos serveurs à partir de la carte du restaurant : un prix modifié côté navigateur est ignoré.',
          'La commande devient ferme dès que le restaurant l’accepte. Jusque-là, tu peux l’annuler depuis l’application.',
        ] },
        { heading: '4. Paiement', paragraphs: [
          'Le paiement se fait uniquement en espèces, à la livraison ou au retrait. Nous n’acceptons ni carte ni paiement en ligne pour le moment, et nous ne détenons jamais ton argent.',
        ] },
        { heading: '5. Codes promotionnels', paragraphs: [
          'Un code peut être limité dans le temps, à un montant minimum, à un restaurant, ou à une utilisation par client. Les conditions exactes s’affichent au moment où tu l’appliques.',
          'Un code obtenu ou utilisé de façon frauduleuse peut être annulé, et la commande correspondante refusée.',
        ] },
        { heading: '6. Obligations du restaurant', paragraphs: [
          'La qualité, l’hygiène, la conformité des plats et le respect du délai annoncé relèvent du restaurant seul. C’est lui qui détient les autorisations sanitaires nécessaires.',
          'Le restaurant s’engage à honorer les commandes acceptées et à signaler sans délai toute rupture.',
        ] },
        { heading: '7. Notre responsabilité', paragraphs: [
          'Nous nous engageons à exploiter la plateforme avec soin et à transmettre fidèlement les commandes. Nous ne sommes pas responsables d’une interruption temporaire du service, ni d’une faute du restaurant.',
          'Rien dans ces conditions ne limite la responsabilité qui ne peut légalement l’être.',
        ] },
        { heading: '8. Modification des conditions', paragraphs: [
          'Nous pouvons faire évoluer ces conditions. La version en vigueur est celle affichée ici. Un changement important est signalé dans l’application.',
        ] },
        { heading: '9. Droit applicable', paragraphs: [
          `Ces conditions sont soumises au droit marocain. En cas de litige, les tribunaux de ${city} sont compétents, après une tentative de règlement amiable.`,
        ] },
      ],
    },
    privacy: {
      title: 'Politique de confidentialité',
      sections: [
        { heading: 'Responsable du traitement', paragraphs: [
          `${name}, ${v('BUSINESS_ADDRESS')}, ${city}. Responsable : ${person}. Contact : ${mail}.`,
        ] },
        { heading: 'Ce que nous collectons, et pourquoi', paragraphs: [
          'Nom, téléphone et adresse de livraison : pour exécuter la commande et permettre au restaurant de te joindre. Sans eux, la commande est impossible.',
          'Email (facultatif) : pour récupérer un mot de passe oublié.',
          'Historique de commandes : pour te l’afficher et pour régler les comptes avec les restaurants.',
          'Messages envoyés depuis la page Aide : pour te répondre.',
          'Données techniques (adresse IP, navigateur, horodatage) : pour la sécurité du service et la détection d’abus.',
        ] },
        { heading: 'Ta position et le point sur la carte', paragraphs: [
          'Quand tu appuies sur « Utiliser ma position », ton navigateur nous transmet une fois tes coordonnées, pour centrer la carte à cet endroit. Tu peux refuser : la carte s’ouvre alors sur le centre-ville et tu places le repère toi-même.',
          'Le point que tu confirmes est enregistré avec ton adresse, et uniquement pour cela : définir l’adresse de livraison et exécuter tes commandes.',
          'Ta position n’est jamais suivie en continu. Nous ne la lisons qu’au moment où tu appuies sur ce bouton, jamais en arrière-plan, jamais quand l’application est fermée.',
          'Le restaurant qui prépare ta commande voit ce point, parce qu’il en a besoin pour te livrer. Il n’est utilisé ni pour de la publicité, ni pour du profilage, ni pour mesurer tes déplacements.',
          'Tu peux modifier ou supprimer une adresse, et son point, à tout moment depuis « Mes adresses ». Les commandes déjà passées gardent l’adresse telle qu’elle était au moment de la commande : c’est le registre de ce qui a été livré, et la comptabilité l’exige.',
        ] },
        { heading: 'Ce que nous ne collectons pas', paragraphs: [
          'Aucune donnée bancaire : le paiement est en espèces et ne passe pas par nous.',
          'Aucun suivi de localisation en arrière-plan, aucun suivi publicitaire, aucun profilage.',
        ] },
        { heading: 'Qui voit tes données', paragraphs: [
          'Le restaurant chez qui tu commandes voit ton nom, ton numéro et ton adresse de livraison. C’est nécessaire pour te livrer.',
          'Notre équipe y accède pour le support et la gestion des litiges, sous permissions nominatives et avec journalisation.',
          'Nous ne vendons ni ne louons tes données. Elles ne quittent pas le Maroc, sauf à t’en informer au préalable.',
        ] },
        { heading: 'Combien de temps', paragraphs: [
          'Compte : tant qu’il est ouvert, puis 12 mois après la dernière activité.',
          'Commandes et montants : 10 ans, durée de conservation comptable.',
          'Messages de support : 24 mois.',
          'Journaux techniques : 12 mois.',
          'Codes de vérification : quelques minutes, puis suppression.',
        ] },
        { heading: 'Tes droits (loi 09-08)', paragraphs: [
          `Tu disposes d’un droit d’accès, de rectification et d’opposition sur tes données. Écris à ${mail} ou appelle le ${phone} ; nous répondons sous 30 jours.`,
          'Tu peux aussi saisir la Commission nationale de contrôle de la protection des données à caractère personnel (CNDP).',
          cndp
            ? `Déclaration CNDP n° ${cndp}.`
            : 'La déclaration auprès de la CNDP est en cours. Cette page sera mise à jour avec le numéro dès qu’il sera délivré ; nous ne revendiquons aucune approbation à ce stade.',
        ] },
        { heading: 'Sécurité', paragraphs: [
          'Les mots de passe sont stockés sous forme d’empreinte et ne peuvent pas être relus, par personne.',
          'Les codes de vérification sont eux aussi stockés sous forme d’empreinte, expirent en quelques minutes et ne servent qu’une fois.',
          'Les accès de l’équipe sont nominatifs et journalisés.',
        ] },
      ],
    },
    cookies: {
      title: 'Cookies et stockage local',
      sections: [
        { heading: 'Nous n’utilisons aucun cookie de suivi', paragraphs: [
          'Pas de cookie publicitaire, pas d’outil d’analyse tiers, aucun suivi d’un site à l’autre.',
        ] },
        { heading: 'Ce que nous gardons dans ton navigateur', paragraphs: [
          'Jeton de session : pour te garder connecté. Effacé à la déconnexion.',
          'Panier : pour ne pas perdre ta commande si tu fermes la page.',
          'Langue choisie : français ou arabe.',
          'Adresse sélectionnée : pour savoir laquelle te proposer au moment de commander.',
          'Adresse saisie avant la création d’un compte : gardée sur cet appareil, puis enregistrée sur ton compte dès ta première connexion.',
          'Tout cela reste sur ton appareil. Tu peux l’effacer depuis les réglages de ton navigateur ; tu seras simplement déconnecté.',
        ] },
        { heading: 'La carte vient d’un service extérieur', paragraphs: [
          'Quand tu ouvres la carte pour placer un repère, les fonds de carte sont téléchargés depuis OpenStreetMap, et le logiciel de carte depuis un service de distribution public. Ces services voient donc ton adresse IP et la zone que tu regardes, comme n’importe quel site que tu visites.',
          'Nous ne leur transmettons ni ton nom, ni ton numéro, ni ton adresse. La carte ne s’ouvre que si tu appuies sur le bouton : si tu saisis ton adresse à la main, aucune requête ne part vers eux.',
        ] },
      ],
    },
    cod: {
      title: 'Paiement en espèces et remboursements',
      sections: [
        { heading: 'Payer à la livraison ou au retrait', paragraphs: [
          'Tu paies en espèces au restaurant, au moment où tu reçois la commande ou quand tu viens la chercher. Le montant affiché dans le panier est le montant final.',
          'Prépare l’appoint si tu le peux : le restaurant n’est pas tenu d’avoir la monnaie.',
        ] },
        { heading: 'Annuler', paragraphs: [
          'Tant que le restaurant n’a pas accepté la commande, tu peux l’annuler gratuitement depuis l’application.',
          'Une fois acceptée, appelle directement le restaurant : son numéro figure sur la commande. Les ingrédients sont peut-être déjà engagés.',
        ] },
        { heading: 'Commande fausse, incomplète ou non livrée', paragraphs: [
          'Appelle le restaurant en premier, c’est le plus rapide.',
          'Si cela ne se règle pas, écris-nous depuis la page Aide dans les 24 heures, avec le numéro de commande. Nous contactons le restaurant.',
        ] },
        { heading: 'Comment fonctionne un remboursement', paragraphs: [
          'Le paiement étant en espèces, le remboursement se fait en espèces par le restaurant, ou en déduction d’une commande suivante si tu en es d’accord.',
          'Nous enregistrons chaque remboursement dans la plateforme et l’imputons au compte du restaurant. Nous ne détenons jamais ton argent, donc nous ne pouvons pas te rembourser directement.',
          'Un remboursement partiel reste possible quand une partie seulement de la commande pose problème.',
        ] },
        { heading: 'Commandes préparées à l’avance (précommandes)', paragraphs: [
          'Une précommande engage le restaurant à acheter et préparer pour une date précise. Annule au plus tôt : passé le délai de préparation annoncé, le restaurant peut refuser l’annulation.',
        ] },
      ],
    },
    retention: {
      title: 'Conservation des données',
      sections: [
        { heading: 'Le principe', paragraphs: [
          'Chaque catégorie de données est conservée le temps nécessaire à sa finalité, puis supprimée ou anonymisée.',
        ] },
        { heading: 'Les durées', paragraphs: [
          'Compte actif : tant qu’il est ouvert.',
          'Compte inactif : supprimé 12 mois après la dernière connexion.',
          'Commandes, montants, commissions : 10 ans (obligation comptable).',
          'Messages de support : 24 mois.',
          'Journal des actions administratives : 24 mois.',
          'Codes de vérification : 5 minutes (inscription) ou 15 minutes (mot de passe oublié).',
          'Sauvegardes : 14 jours glissants.',
        ] },
        { heading: 'Supprimer ton compte', paragraphs: [
          `Écris à ${mail} depuis l’adresse ou le numéro associé au compte. Nous confirmons la suppression sous 30 jours.`,
          'Les commandes déjà passées sont conservées comme pièces comptables, mais détachées de ton identité.',
        ] },
      ],
    },
    contact: {
      title: 'Nous contacter',
      sections: [
        { heading: 'Clients', paragraphs: [
          `Téléphone : ${phone}`,
          `Email : ${mail}`,
          'Ou depuis la page Aide dans l’application : nous répondons sous un jour ouvré.',
        ] },
        { heading: 'Restaurants', paragraphs: [
          'Même numéro et même adresse. Pour t’inscrire, ouvre l’espace restaurant depuis la page Compte.',
        ] },
        { heading: 'Questions légales et protection des données', paragraphs: [
          `${person} — ${mail}`,
          `${v('BUSINESS_ADDRESS')}, ${city}`,
        ] },
      ],
    },
  };
}

/**
 * The CNDP / law 09-08 checklist shown to the administrator.
 * It is a checklist to work through, not a statement that anything is done.
 */
export const CNDP_CHECKLIST = {
  fr: {
    title: 'Conformité CNDP — loi 09-08',
    intro: 'À vérifier avec un juriste marocain avant d’ouvrir au public. Cette liste t’aide à préparer le dossier ; elle ne vaut ni avis juridique ni approbation.',
    items: [
      'Identifier le responsable du traitement, nommément, et le renseigner dans la configuration.',
      'Recenser les traitements : comptes clients, commandes, messages de support, journaux techniques.',
      'Déterminer, pour chaque traitement, la finalité, la base légale, les destinataires et la durée de conservation.',
      'Vérifier auprès de la CNDP si une déclaration préalable est requise pour ces traitements, et laquelle.',
      'Déposer la déclaration si elle est requise, puis reporter le numéro obtenu dans la configuration.',
      'Afficher une politique de confidentialité complète et accessible avant la collecte.',
      'Recueillir et conserver la preuve de l’acceptation des conditions à l’inscription.',
      'Mettre en place une procédure écrite pour répondre sous 30 jours aux demandes d’accès, de rectification et d’opposition.',
      'Limiter l’accès aux données aux personnes qui en ont besoin, avec des comptes nominatifs.',
      'Journaliser les accès administratifs et les conserver.',
      'Chiffrer les échanges (HTTPS) avant toute collecte sur Internet.',
      'Sauvegarder les données, tester la restauration, et stocker une copie hors de la machine.',
      'Prévoir une procédure en cas de violation de données : constat, notification, information des personnes.',
      'Encadrer par écrit ce que les restaurants partenaires peuvent faire des coordonnées des clients.',
      'Réexaminer cette liste à chaque nouvelle fonctionnalité qui collecte une donnée.',
    ],
  },
  ar: {
    title: 'الامتثال لـ CNDP — القانون 09-08',
    intro: 'يجب التحقق من هذه النقاط مع محام مغربي قبل الفتح للعموم. هذه قائمة للتحضير، وليست رأيا قانونيا ولا موافقة.',
    items: [
      'تحديد المسؤول عن المعالجة بالاسم، وإدراجه في الإعدادات.',
      'جرد المعالجات: حسابات الزبناء، الطلبات، رسائل الدعم، السجلات التقنية.',
      'تحديد الغاية والأساس القانوني والمرسل إليهم ومدة الاحتفاظ لكل معالجة.',
      'التحقق لدى CNDP إن كان التصريح المسبق مطلوبا، وأي نوع منه.',
      'إيداع التصريح إن كان مطلوبا، ثم إدراج الرقم المحصل عليه في الإعدادات.',
      'عرض سياسة خصوصية كاملة وسهلة الوصول قبل أي جمع للبيانات.',
      'جمع وحفظ دليل قبول الشروط عند التسجيل.',
      'وضع مسطرة مكتوبة للجواب خلال 30 يوما على طلبات الوصول والتصحيح والاعتراض.',
      'حصر الوصول إلى البيانات في من يحتاجها، بحسابات اسمية.',
      'تسجيل عمليات الوصول الإدارية والاحتفاظ بها.',
      'تشفير الاتصالات (HTTPS) قبل أي جمع عبر الإنترنت.',
      'النسخ الاحتياطي للبيانات، واختبار الاسترجاع، وحفظ نسخة خارج الجهاز.',
      'إعداد مسطرة في حالة خرق البيانات: المعاينة، الإشعار، إخبار الأشخاص.',
      'تأطير ما يمكن للمطاعم الشريكة فعله بمعطيات الزبناء، كتابة.',
      'مراجعة هذه القائمة عند كل وظيفة جديدة تجمع معطيات.',
    ],
  },
};
