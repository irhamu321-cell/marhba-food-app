/*
 * The ten demo restaurants.
 *
 * Kept apart from schema.js so the catalogue can grow without touching the
 * table definitions. Everything here is plain data: prices are centimes of
 * MAD, `emoji` stands in for a logo, and `veg: true` marks a vegetarian dish.
 *
 * Delivery days use 0 = Sunday … 6 = Saturday. Slots are "HH:MM-HH:MM".
 */

export const DEMO_RESTAURANTS = [
  /* ------------------------------------------------------------ Italian 1 */
  {
    name: 'Bella Napoli', name_ar: 'بيلا نابولي', emoji: '🍕',
    city: 'Kénitra', address: '14 Avenue Mohammed V', phone: '0537100001',
    description: 'Vraies pizzas napolitaines cuites au feu de bois, pâtes fraîches du jour.',
    description_ar: 'بيتزا نابولية أصلية على الحطب، ومعكرونة طازجة يوميا.',
    cuisines: 'italienne', service_type: 'immediate',
    commission_bp: 1500, delivery_fee: 1500, min_order: 6000, prep: 30, rating_bp: 46000,
    owner: { name: 'Marco Benali', email: 'bella@demo.ma', phone: '0611000001' },
    categories: [
      { name: 'Pizzas', name_ar: 'بيتزا', products: [
        { name: 'Pizza Margherita', name_ar: 'بيتزا مارغريتا', price: 6000, veg: true,
          description: 'Tomate San Marzano, mozzarella fior di latte, basilic frais',
          description_ar: 'طماطم، موزاريلا، ريحان طازج',
          groups: [
            { name: 'Taille', name_ar: 'الحجم', min: 1, max: 1,
              options: [['Petite', 'صغيرة', 0], ['Moyenne', 'متوسطة', 1500], ['Grande', 'كبيرة', 3000]] },
            { name: 'Supplements', name_ar: 'إضافات', min: 0, max: 4,
              options: [['Mozzarella extra', 'موزاريلا إضافية', 1200], ['Roquette', 'جرجير', 800],
                        ['Olives', 'زيتون', 600], ['Piment', 'فلفل حار', 400]] },
          ] },
        { name: 'Pizza Diavola', name_ar: 'بيتزا ديافولا', price: 7500,
          description: 'Salami piquant, mozzarella, origan',
          description_ar: 'سلامي حار، موزاريلا، زعتر',
          groups: [
            { name: 'Taille', name_ar: 'الحجم', min: 1, max: 1,
              options: [['Moyenne', 'متوسطة', 0], ['Grande', 'كبيرة', 1800]] },
          ] },
        { name: 'Pizza Quatre Fromages', name_ar: 'بيتزا أربعة أجبان', price: 8000, veg: true,
          description: 'Mozzarella, gorgonzola, parmesan, chèvre',
          description_ar: 'موزاريلا، غورغونزولا، بارميزان، جبن الماعز' },
      ] },
      { name: 'Pâtes', name_ar: 'معكرونة', products: [
        { name: 'Pâtes Carbonara', name_ar: 'معكرونة كاربونارا', price: 7000,
          description: 'Oeuf, pecorino, poitrine fumée, poivre noir',
          description_ar: 'بيض، بيكورينو، لحم مدخن، فلفل أسود' },
        { name: 'Lasagnes maison', name_ar: 'لازانيا بيتية', price: 7800,
          description: 'Bolognaise mijotée 4 heures, béchamel',
          description_ar: 'صلصة بولونيز مطهوة 4 ساعات، بشاميل' },
      ] },
      { name: 'Desserts', name_ar: 'حلويات', products: [
        { name: 'Tiramisu', name_ar: 'تيراميسو', price: 3500, veg: true,
          description: 'Mascarpone, café, cacao', description_ar: 'ماسكاربوني، قهوة، كاكاو' },
      ] },
      { name: 'Boissons', name_ar: 'مشروبات', products: [
        { name: 'Limonade maison', name_ar: 'ليموناضة بيتية', price: 2000, veg: true },
        { name: 'Eau minérale 50cl', name_ar: 'ماء معدني 50 سل', price: 800, veg: true },
      ] },
    ],
  },

  /* ------------------------------------------------------------ Italian 2 */
  {
    name: 'Roma Gourmet', name_ar: 'روما غورميه', emoji: '🍝',
    city: 'Kénitra', address: '3 Rue de Rome', phone: '0537100002',
    description: 'Cuisine italienne raffinée, préparée à la commande, 24h à l’avance.',
    description_ar: 'مطبخ إيطالي راق، يحضر حسب الطلب قبل 24 ساعة.',
    cuisines: 'italienne', service_type: 'preorder',
    min_prep_hours: 24, delivery_days: '2,3,4,5,6', delivery_slots: '12:00-14:00,19:00-21:00',
    order_cutoff: '18:00',
    commission_bp: 1500, delivery_fee: 2000, min_order: 12000, prep: 45, rating_bp: 48000,
    owner: { name: 'Giulia Amrani', email: 'roma@demo.ma', phone: '0611000002' },
    categories: [
      { name: 'Entrees', name_ar: 'مقبلات', products: [
        { name: 'Salade Caprese', name_ar: 'سلطة كابريزي', price: 4500, veg: true,
          description: 'Tomate, mozzarella di bufala, basilic, huile d’olive',
          description_ar: 'طماطم، موزاريلا بوفالا، ريحان، زيت الزيتون' },
        { name: 'Bruschetta truffe', name_ar: 'بروشيتا بالكمأة', price: 5500, veg: true,
          description: 'Pain grillé, crème de truffe, parmesan',
          description_ar: 'خبز محمص، كريمة الكمأة، بارميزان' },
      ] },
      { name: 'Plats', name_ar: 'أطباق رئيسية', products: [
        { name: 'Risotto aux champignons', name_ar: 'ريزوتو بالفطر', price: 9500, veg: true,
          description: 'Arborio, cèpes, parmesan 24 mois',
          description_ar: 'أرز أربوريو، فطر، بارميزان 24 شهرا',
          groups: [
            { name: 'Portion', name_ar: 'الحصة', min: 1, max: 1,
              options: [['Individuelle', 'فردية', 0], ['Pour 2', 'لشخصين', 7000]] },
          ] },
        { name: 'Tagliatelles au saumon', name_ar: 'تالياتيلي بالسلمون', price: 11000,
          description: 'Saumon frais, crème légère, aneth',
          description_ar: 'سلمون طازج، كريمة خفيفة، شبت' },
        { name: 'Escalope milanaise', name_ar: 'إسكالوب ميلانيز', price: 10500,
          description: 'Veau pané, spaghetti au beurre',
          description_ar: 'لحم عجل مقلي، سباغيتي بالزبدة' },
      ] },
      { name: 'Desserts', name_ar: 'حلويات', products: [
        { name: 'Panna Cotta', name_ar: 'بانا كوتا', price: 4000, veg: true,
          description: 'Vanille de Madagascar, coulis de fruits rouges',
          description_ar: 'فانيليا، صلصة الفواكه الحمراء' },
        { name: 'Tiramisu classique', name_ar: 'تيراميسو كلاسيكي', price: 4200, veg: true },
      ] },
    ],
  },

  /* ------------------------------------------------------------ Italian 3 */
  {
    name: 'La Trattoria Kénitra', name_ar: 'لا تراتوريا القنيطرة', emoji: '🍅',
    city: 'Kénitra', address: '22 Boulevard Hassan II', phone: '0537100003',
    description: 'La trattoria de quartier: générosité, prix justes, service rapide.',
    description_ar: 'تراتوريا الحي: كرم، أثمنة مناسبة، خدمة سريعة.',
    cuisines: 'italienne', service_type: 'immediate',
    commission_bp: 1400, delivery_fee: 1200, min_order: 5000, prep: 25, rating_bp: 43000,
    owner: { name: 'Hamza Riad', email: 'trattoria@demo.ma', phone: '0611000003' },
    categories: [
      { name: 'Pizzas', name_ar: 'بيتزا', products: [
        { name: 'Pizza Quatre Fromages', name_ar: 'بيتزا أربعة أجبان', price: 7200, veg: true,
          description: 'Mozzarella, emmental, bleu, chèvre',
          description_ar: 'موزاريلا، إيمنتال، جبن أزرق، جبن الماعز',
          groups: [
            { name: 'Taille', name_ar: 'الحجم', min: 1, max: 1,
              options: [['Moyenne', 'متوسطة', 0], ['Grande', 'كبيرة', 2000], ['Familiale', 'عائلية', 3800]] },
          ] },
        { name: 'Pizza Végétarienne', name_ar: 'بيتزا نباتية', price: 6800, veg: true,
          description: 'Courgette, aubergine, poivron, champignons',
          description_ar: 'كوسة، باذنجان، فلفل، فطر' },
      ] },
      { name: 'Pâtes', name_ar: 'معكرونة', products: [
        { name: 'Pâtes Bolognaise', name_ar: 'معكرونة بولونيز', price: 6500,
          description: 'Sauce viande maison, parmesan râpé',
          description_ar: 'صلصة اللحم البيتية، بارميزان مبشور',
          groups: [
            { name: 'Type de pâtes', name_ar: 'نوع المعكرونة', min: 1, max: 1,
              options: [['Spaghetti', 'سباغيتي', 0], ['Penne', 'بيني', 0], ['Tagliatelles', 'تالياتيلي', 500]] },
          ] },
        { name: 'Penne Arrabiata', name_ar: 'بيني أرابياتا', price: 5500, veg: true,
          description: 'Tomate, ail, piment', description_ar: 'طماطم، ثوم، فلفل حار' },
      ] },
      { name: 'Entrees', name_ar: 'مقبلات', products: [
        { name: 'Salade Caprese', name_ar: 'سلطة كابريزي', price: 4200, veg: true },
      ] },
      { name: 'Desserts', name_ar: 'حلويات', products: [
        { name: 'Tiramisu', name_ar: 'تيراميسو', price: 3200, veg: true },
      ] },
      { name: 'Boissons', name_ar: 'مشروبات', products: [
        { name: 'Coca 33cl', name_ar: 'كوكا 33 سل', price: 1000, veg: true },
      ] },
    ],
  },

  /* ------------------------------------------------------------ Italian 4 */
  {
    name: 'Milano Cucina', name_ar: 'ميلانو كوتشينا', emoji: '🥘',
    city: 'Kénitra', address: '8 Rue des Oliviers', phone: '0537100004',
    description: 'Plateaux italiens pour évènements et grandes tablées, sur commande, 48h à l’avance.',
    description_ar: 'أطباق إيطالية للمناسبات والعائلات الكبيرة، بطلب قبل 48 ساعة.',
    cuisines: 'italienne', service_type: 'preorder',
    min_prep_hours: 48, delivery_days: '4,5,6', delivery_slots: '11:00-13:00,17:00-19:00',
    order_cutoff: '16:00',
    commission_bp: 1600, delivery_fee: 3000, min_order: 30000, prep: 90, rating_bp: 47000,
    owner: { name: 'Nadia Belkadi', email: 'milano@demo.ma', phone: '0611000004' },
    categories: [
      { name: 'Plateaux', name_ar: 'أطباق جماعية', products: [
        { name: 'Plateau de pâtes pour évènements', name_ar: 'طبق معكرونة للمناسبات', price: 45000,
          description: 'Trois pâtes au choix, pour 10 à 12 personnes',
          description_ar: 'ثلاثة أنواع معكرونة، لـ 10 إلى 12 شخصا',
          groups: [
            { name: 'Nombre de personnes', name_ar: 'عدد الأشخاص', min: 1, max: 1,
              options: [['10 personnes', '10 أشخاص', 0], ['15 personnes', '15 شخصا', 18000],
                        ['20 personnes', '20 شخصا', 35000]] },
            { name: 'Choix des pâtes', name_ar: 'اختيار المعكرونة', min: 1, max: 3,
              options: [['Bolognaise', 'بولونيز', 0], ['Carbonara', 'كاربونارا', 0],
                        ['Arrabiata (végétarien)', 'أرابياتا (نباتي)', 0], ['Pesto (végétarien)', 'بيستو (نباتي)', 0]] },
          ] },
        { name: 'Lasagnes familiales', name_ar: 'لازانيا عائلية', price: 26000,
          description: 'Grand plat, 8 à 10 parts', description_ar: 'طبق كبير، 8 إلى 10 حصص' },
        { name: 'Risotto royal', name_ar: 'ريزوتو ملكي', price: 32000,
          description: 'Fruits de mer, safran, pour 8 personnes',
          description_ar: 'فواكه البحر، زعفران، لـ 8 أشخاص' },
        { name: 'Plateau de légumes grillés', name_ar: 'طبق خضر مشوية', price: 18000, veg: true,
          description: 'Aubergine, courgette, poivron, huile d’olive et herbes',
          description_ar: 'باذنجان، كوسة، فلفل، زيت الزيتون والأعشاب' },
      ] },
      { name: 'Desserts', name_ar: 'حلويات', products: [
        { name: 'Desserts italiens assortis', name_ar: 'حلويات إيطالية متنوعة', price: 15000, veg: true,
          description: 'Tiramisu, panna cotta, cannoli - 12 pièces',
          description_ar: 'تيراميسو، بانا كوتا، كانولي - 12 قطعة' },
        { name: 'Plateau de cannoli', name_ar: 'طبق كانولي', price: 12000, veg: true,
          description: '15 pièces, ricotta et pistache', description_ar: '15 قطعة، ريكوتا وفستق' },
      ] },
    ],
  },

  /* ------------------------------------------------------------- Moroccan */
  {
    name: 'Dar Zaki', name_ar: 'دار زكي', emoji: '🥙',
    city: 'Kénitra', address: '45 Rue Oued Sebou', phone: '0537100005',
    description: 'Cuisine marocaine de maison: tajines mijotés, couscous du vendredi, pastilla.',
    description_ar: 'مطبخ مغربي بيتي: طواجن، كسكس الجمعة، وبسطيلة.',
    cuisines: 'marocaine', service_type: 'immediate',
    commission_bp: 1300, delivery_fee: 1000, min_order: 5000, prep: 35, rating_bp: 47000,
    owner: { name: 'Zakia Lahlou', email: 'darzaki@demo.ma', phone: '0611000005' },
    categories: [
      { name: 'Tajines', name_ar: 'طواجن', products: [
        { name: 'Tajine poulet citron olives', name_ar: 'طاجين الدجاج بالليمون والزيتون', price: 7000,
          description: 'Poulet fermier, citron confit, olives violettes',
          description_ar: 'دجاج بلدي، ليمون مصبر، زيتون',
          groups: [
            { name: 'Accompagnement', name_ar: 'التقدمة', min: 1, max: 1,
              options: [['Pain maison', 'خبز بيتي', 0], ['Riz', 'أرز', 500], ['Frites', 'بطاطس مقلية', 700]] },
          ] },
        { name: 'Tajine kefta oeuf', name_ar: 'طاجين الكفتة بالبيض', price: 6500,
          description: 'Boulettes de viande, tomate, oeuf',
          description_ar: 'كرات اللحم، طماطم، بيض' },
        { name: 'Tajine légumes', name_ar: 'طاجين الخضر', price: 5500, veg: true,
          description: 'Sept légumes de saison, épices douces',
          description_ar: 'سبع خضر موسمية، بهارات خفيفة' },
      ] },
      { name: 'Plats', name_ar: 'أطباق', products: [
        { name: 'Couscous aux sept légumes', name_ar: 'كسكس بسبع خضر', price: 8000, veg: true,
          description: 'Semoule roulée à la main, bouillon parfumé',
          description_ar: 'كسكس مفتول يدويا، مرق معطر',
          groups: [
            { name: 'Viande', name_ar: 'اللحم', min: 0, max: 1,
              options: [['Sans viande', 'بدون لحم', 0], ['Poulet', 'دجاج', 1500], ['Agneau', 'لحم الغنم', 2500]] },
          ] },
        { name: 'Pastilla au poulet', name_ar: 'بسطيلة بالدجاج', price: 9000,
          description: 'Feuille de brick, amandes, cannelle',
          description_ar: 'ورقة بسطيلة، لوز، قرفة' },
      ] },
      { name: 'Salades', name_ar: 'سلطات', products: [
        { name: 'Salades marocaines variées', name_ar: 'سلطات مغربية متنوعة', price: 3500, veg: true,
          description: 'Zaalouk, taktouka, carottes à la cannelle',
          description_ar: 'زعلوك، تكتوكة، جزر بالقرفة' },
      ] },
      { name: 'Boissons', name_ar: 'مشروبات', products: [
        { name: 'Thé à la menthe', name_ar: 'أتاي بالنعناع', price: 1200, veg: true },
        { name: 'Jus d’avocat', name_ar: 'عصير الأفوكادو', price: 2000, veg: true },
      ] },
    ],
  },

  /* ------------------------------------------------------------ Grillades */
  {
    name: 'Le Grill Royal', name_ar: 'لو غريل رويال', emoji: '🔥',
    city: 'Kénitra', address: '2 Avenue des FAR', phone: '0537100006',
    description: 'Grillades au charbon: brochettes, kefta, côtelettes et frites maison.',
    description_ar: 'مشويات على الفحم: قطبان، كفتة، كستليطة وبطاطس بيتية.',
    cuisines: 'grillades', service_type: 'immediate',
    commission_bp: 1500, delivery_fee: 1200, min_order: 6000, prep: 30, rating_bp: 44000,
    owner: { name: 'Rachid Boukhari', email: 'grill@demo.ma', phone: '0611000006' },
    categories: [
      { name: 'Grillades', name_ar: 'مشويات', products: [
        { name: 'Brochettes de poulet', name_ar: 'قطبان الدجاج', price: 7000,
          description: 'Quatre brochettes marinées, pain et sauce',
          description_ar: 'أربعة قطبان متبلة، خبز وصلصة',
          groups: [
            { name: 'Cuisson', name_ar: 'درجة الطهي', min: 1, max: 1,
              options: [['A point', 'متوسط', 0], ['Bien cuit', 'مطهو جيدا', 0]] },
            { name: 'Sauces', name_ar: 'الصلصات', min: 0, max: 3,
              options: [['Harissa', 'هريسة', 0], ['Ail', 'ثوم', 0], ['Blanche', 'بيضاء', 0]] },
          ] },
        { name: 'Kefta grillée', name_ar: 'كفتة مشوية', price: 6500,
          description: 'Viande hachée épicée, persil, oignon',
          description_ar: 'لحم مفروم متبل، معدنوس، بصل' },
        { name: 'Côtelettes d agneau', name_ar: 'كستليطة الغنم', price: 11000,
          description: 'Six côtelettes, sel de mer et cumin',
          description_ar: 'ست قطع، ملح البحر والكمون' },
        { name: 'Assiette mixte', name_ar: 'طبق مشكل', price: 13000,
          description: 'Poulet, kefta et merguez', description_ar: 'دجاج، كفتة ومرقاز' },
      ] },
      { name: 'Accompagnements', name_ar: 'تقدمات', products: [
        { name: 'Frites maison', name_ar: 'بطاطس بيتية', price: 2000, veg: true },
        { name: 'Salade verte', name_ar: 'سلطة خضراء', price: 2500, veg: true },
        { name: 'Riz parfumé', name_ar: 'أرز معطر', price: 2200, veg: true },
      ] },
      { name: 'Boissons', name_ar: 'مشروبات', products: [
        { name: 'Citronnade fraîche', name_ar: 'ليموناضة طازجة', price: 1500, veg: true },
      ] },
    ],
  },

  /* ------------------------------------------------------------- Fastfood */
  {
    name: 'Burger House', name_ar: 'برغر هاوس', emoji: '🍔',
    city: 'Kénitra', address: '77 Boulevard Zerktouni', phone: '0537100007',
    description: 'Burgers smash, wraps croustillants, frites fraîches et milkshakes.',
    description_ar: 'برغر، راب، بطاطس طازجة وميلك شيك.',
    cuisines: 'fastfood', service_type: 'immediate',
    commission_bp: 1600, delivery_fee: 1000, min_order: 4000, prep: 20, rating_bp: 42000,
    owner: { name: 'Omar Sefrioui', email: 'burger@demo.ma', phone: '0611000007' },
    categories: [
      { name: 'Burgers', name_ar: 'برغر', products: [
        { name: 'Classic Cheeseburger', name_ar: 'تشيز برغر كلاسيك', price: 4500,
          description: 'Steak smash, cheddar, cornichon, sauce maison',
          description_ar: 'لحم، شيدر، مخلل، صلصة بيتية',
          groups: [
            { name: 'Taille', name_ar: 'الحجم', min: 1, max: 1,
              options: [['Simple', 'عادي', 0], ['Double steak', 'لحم مضاعف', 2000]] },
            { name: 'Supplements', name_ar: 'إضافات', min: 0, max: 5,
              options: [['Bacon de dinde', 'بيكون الديك الرومي', 1000], ['Cheddar extra', 'شيدر إضافي', 700],
                        ['Oeuf', 'بيضة', 500], ['Oignons frits', 'بصل مقلي', 600]] },
          ] },
        { name: 'Chicken Crispy Burger', name_ar: 'برغر الدجاج المقرمش', price: 4800,
          description: 'Filet pané, salade, sauce ranch',
          description_ar: 'دجاج مقرمش، سلطة، صلصة رانش' },
        { name: 'Veggie Burger', name_ar: 'برغر نباتي', price: 4200, veg: true,
          description: 'Galette pois chiches, avocat, tomate',
          description_ar: 'قرص الحمص، أفوكادو، طماطم' },
      ] },
      { name: 'Wraps', name_ar: 'راب', products: [
        { name: 'Wrap poulet césar', name_ar: 'راب الدجاج سيزر', price: 4000,
          description: 'Poulet grillé, parmesan, sauce césar',
          description_ar: 'دجاج مشوي، بارميزان، صلصة سيزر' },
        { name: 'Wrap falafel', name_ar: 'راب الفلافل', price: 3500, veg: true,
          description: 'Falafel, houmous, crudités', description_ar: 'فلافل، حمص، خضر' },
      ] },
      { name: 'Accompagnements', name_ar: 'تقدمات', products: [
        { name: 'Frites fraîches', name_ar: 'بطاطس طازجة', price: 1800, veg: true,
          groups: [
            { name: 'Portion', name_ar: 'الحصة', min: 1, max: 1,
              options: [['Moyenne', 'متوسطة', 0], ['Grande', 'كبيرة', 800]] },
          ] },
        { name: 'Onion rings', name_ar: 'حلقات البصل', price: 2200, veg: true },
      ] },
      { name: 'Boissons', name_ar: 'مشروبات', products: [
        { name: 'Milkshake vanille', name_ar: 'ميلك شيك فانيليا', price: 2500, veg: true },
        { name: 'Milkshake Oreo', name_ar: 'ميلك شيك أوريو', price: 2800, veg: true },
      ] },
    ],
  },

  /* ------------------------------------------------------------- Asiatique */
  {
    name: 'Sushi Kénitra', name_ar: 'سوشي القنيطرة', emoji: '🍣',
    city: 'Kénitra', address: '30 Avenue Al Massira', phone: '0537100008',
    description: 'Sushi prépare le jour même, poisson sélectionné. Commande 24h à l’avance.',
    description_ar: 'سوشي محضر في نفس اليوم، سمك منتقى. الطلب قبل 24 ساعة.',
    cuisines: 'asiatique', service_type: 'preorder',
    min_prep_hours: 24, delivery_days: '3,4,5,6', delivery_slots: '12:30-14:30,19:00-21:30',
    order_cutoff: '20:00',
    commission_bp: 1500, delivery_fee: 2000, min_order: 15000, prep: 60, rating_bp: 49000,
    owner: { name: 'Kenji Alaoui', email: 'sushi@demo.ma', phone: '0611000008' },
    categories: [
      { name: 'Sushi', name_ar: 'سوشي', products: [
        { name: 'Sushi box 12 pièces', name_ar: 'علبة سوشي 12 قطعة', price: 16000,
          description: 'Saumon, thon, crevette, avocat',
          description_ar: 'سلمون، تونة، روبيان، أفوكادو',
          groups: [
            { name: 'Taille de la box', name_ar: 'حجم العلبة', min: 1, max: 1,
              options: [['12 pièces', '12 قطعة', 0], ['24 pièces', '24 قطعة', 14000],
                        ['36 pièces', '36 قطعة', 26000]] },
            { name: 'Accompagnements', name_ar: 'تقدمات', min: 0, max: 3,
              options: [['Wasabi extra', 'واسابي إضافي', 0], ['Gingembre', 'زنجبيل', 0],
                        ['Sauce soja sucree', 'صلصة الصويا الحلوة', 500]] },
          ] },
        { name: 'Makis saumon avocat', name_ar: 'ماكي سلمون أفوكادو', price: 7000,
          description: 'Six pièces, riz vinaigre', description_ar: 'ست قطع، أرز بالخل' },
        { name: 'Makis végétariens', name_ar: 'ماكي نباتي', price: 6000, veg: true,
          description: 'Concombre, avocat, carotte, sésame',
          description_ar: 'خيار، أفوكادو، جزر، سمسم' },
      ] },
      { name: 'Plats chauds', name_ar: 'أطباق ساخنة', products: [
        { name: 'Ramen au poulet', name_ar: 'رامن بالدجاج', price: 8500,
          description: 'Bouillon 12 heures, nouilles fraîches, oeuf mollet',
          description_ar: 'مرق 12 ساعة، نودلز طازجة، بيضة' },
        { name: 'Gyozas (6 pièces)', name_ar: 'غيوزا (6 قطع)', price: 5000,
          description: 'Raviolis grillés au porc ou aux légumes',
          description_ar: 'راڤيولي مشوية',
          groups: [
            { name: 'Garniture', name_ar: 'الحشوة', min: 1, max: 1,
              options: [['Poulet', 'دجاج', 0], ['Légumes (végétarien)', 'خضر (نباتي)', 0]] },
          ] },
      ] },
      { name: 'Boissons', name_ar: 'مشروبات', products: [
        { name: 'Thé vert glacé', name_ar: 'شاي أخضر مثلج', price: 1800, veg: true },
      ] },
    ],
  },

  /* --------------------------------------------------------------- Healthy */
  {
    name: 'Fit & Fresh', name_ar: 'فيت أند فريش', emoji: '🥗',
    city: 'Kénitra', address: '5 Rue des Sports', phone: '0537100009',
    description: 'Bowls équilibrés, salades généreuses, smoothies et plats protéinés.',
    description_ar: 'أطباق متوازنة، سلطات، عصائر وأطباق غنية بالبروتين.',
    cuisines: 'healthy', service_type: 'immediate',
    commission_bp: 1400, delivery_fee: 1200, min_order: 5000, prep: 20, rating_bp: 45000,
    owner: { name: 'Sara Bennani', email: 'fit@demo.ma', phone: '0611000009' },
    categories: [
      { name: 'Bowls', name_ar: 'أطباق', products: [
        { name: 'Poke bowl saumon', name_ar: 'بوكي بول سلمون', price: 8500,
          description: 'Riz, saumon, edamame, avocat, sésame',
          description_ar: 'أرز، سلمون، إدامامي، أفوكادو، سمسم',
          groups: [
            { name: 'Base', name_ar: 'القاعدة', min: 1, max: 1,
              options: [['Riz blanc', 'أرز أبيض', 0], ['Quinoa', 'كينوا', 500], ['Salade', 'سلطة', 0]] },
            { name: 'Supplements', name_ar: 'إضافات', min: 0, max: 4,
              options: [['Avocat extra', 'أفوكادو إضافي', 900], ['Graines', 'بذور', 400],
                        ['Feta', 'فيتا', 700]] },
          ] },
        { name: 'Buddha bowl végétarien', name_ar: 'بودا بول نباتي', price: 7000, veg: true,
          description: 'Quinoa, pois chiches rôtis, patate douce, tahini',
          description_ar: 'كينوا، حمص محمص، بطاطا حلوة، طحينة' },
      ] },
      { name: 'Salades', name_ar: 'سلطات', products: [
        { name: 'Salade césar au poulet', name_ar: 'سلطة سيزر بالدجاج', price: 6500,
          description: 'Poulet grillé, parmesan, croûtons complets',
          description_ar: 'دجاج مشوي، بارميزان، خبز محمص' },
        { name: 'Salade grecque', name_ar: 'سلطة يونانية', price: 5500, veg: true,
          description: 'Concombre, tomate, feta, olives',
          description_ar: 'خيار، طماطم، فيتا، زيتون' },
      ] },
      { name: 'Plats protéinés', name_ar: 'أطباق بروتينية', products: [
        { name: 'Poulet grillé et légumes vapeur', name_ar: 'دجاج مشوي وخضر على البخار', price: 7500,
          description: '180g de poulet, brocoli, haricots verts',
          description_ar: '180غ دجاج، بروكلي، فاصوليا خضراء' },
        { name: 'Omelette blancs d’oeufs', name_ar: 'أومليت بياض البيض', price: 4500, veg: true,
          description: 'Quatre blancs, épinards, champignons',
          description_ar: 'أربعة بياضات، سبانخ، فطر' },
      ] },
      { name: 'Smoothies', name_ar: 'عصائر', products: [
        { name: 'Smoothie mangue banane', name_ar: 'سموذي مانغو موز', price: 3000, veg: true },
        { name: 'Smoothie détox vert', name_ar: 'سموذي أخضر', price: 3200, veg: true,
          description: 'Épinards, pomme, citron, gingembre',
          description_ar: 'سبانخ، تفاح، ليمون، زنجبيل' },
      ] },
    ],
  },

  /* -------------------------------------------------------------- Desserts */
  {
    name: 'Douceurs & Co', name_ar: 'دوسور أند كو', emoji: '🎂',
    city: 'Kénitra', address: '11 Rue des Fleurs', phone: '0537100010',
    description: 'Gâteaux personnalisés, cheesecakes et macarons, prépare sur commande.',
    description_ar: 'كعك حسب الطلب، تشيزكيك وماكارون، تحضر خصيصا لك.',
    cuisines: 'desserts', service_type: 'preorder',
    min_prep_hours: 24, delivery_days: '1,2,3,4,5,6', delivery_slots: '10:00-12:00,15:00-17:00,18:00-20:00',
    order_cutoff: '17:00',
    commission_bp: 1500, delivery_fee: 1500, min_order: 10000, prep: 120, rating_bp: 48000,
    owner: { name: 'Imane Chraibi', email: 'douceurs@demo.ma', phone: '0611000010' },
    categories: [
      { name: 'Gâteaux', name_ar: 'كعك', products: [
        { name: 'Gâteau personnalisé', name_ar: 'كعكة حسب الطلب', price: 25000, veg: true,
          description: 'Choisis la taille, le parfum et le message',
          description_ar: 'اختر الحجم والنكهة والرسالة',
          groups: [
            { name: 'Taille', name_ar: 'الحجم', min: 1, max: 1,
              options: [['6 parts', '6 حصص', 0], ['10 parts', '10 حصص', 10000],
                        ['16 parts', '16 حصة', 22000]] },
            { name: 'Parfum', name_ar: 'النكهة', min: 1, max: 1,
              options: [['Chocolat', 'شوكولاتة', 0], ['Vanille fraise', 'فانيليا وفراولة', 0],
                        ['Citron meringué', 'ليمون ميرانغ', 1500], ['Pistache', 'فستق', 2500]] },
            { name: 'Decoration', name_ar: 'التزيين', min: 0, max: 2,
              options: [['Message écrit', 'رسالة مكتوبة', 0], ['Fleurs en sucré', 'ورود سكرية', 3000],
                        ['Bougies', 'شموع', 500]] },
          ] },
        { name: 'Layer cake chocolat', name_ar: 'كعكة الشوكولاتة بالطبقات', price: 22000, veg: true,
          description: 'Quatre étages, ganache et noisette',
          description_ar: 'أربع طبقات، غاناش وبندق' },
      ] },
      { name: 'Cheesecakes', name_ar: 'تشيزكيك', products: [
        { name: 'Cheesecake New York', name_ar: 'تشيزكيك نيويورك', price: 18000, veg: true,
          description: 'Entier, 8 parts, coulis au choix',
          description_ar: 'كامل، 8 حصص، صلصة حسب الاختيار' },
        { name: 'Cheesecake citron', name_ar: 'تشيزكيك بالليمون', price: 18000, veg: true },
      ] },
      { name: 'Petits gâteaux', name_ar: 'حلويات صغيرة', products: [
        { name: 'Macarons (12 pièces)', name_ar: 'ماكارون (12 قطعة)', price: 12000, veg: true,
          description: 'Six parfums au choix', description_ar: 'ست نكهات حسب الاختيار' },
        { name: 'Cupcakes (6 pièces)', name_ar: 'كب كيك (6 قطع)', price: 9000, veg: true },
      ] },
      { name: 'Évènements', name_ar: 'المناسبات', products: [
        { name: 'Desserts pour évènements', name_ar: 'حلويات للمناسبات', price: 40000, veg: true,
          description: 'Buffet sucré pour 20 personnes, assortiment complet',
          description_ar: 'بوفيه حلويات لـ 20 شخصا، تشكيلة كاملة' },
      ] },
    ],
  },
];
