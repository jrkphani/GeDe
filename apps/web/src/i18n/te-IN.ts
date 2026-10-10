import type { Messages } from './messages.js';

/** తెలుగు (India). Product names (GeDe, Numbers, iCloud, workscape) and typed tokens stay as written. */
export const messages: Messages = {
  'tour.counter': 'దశ {step} / {total}',
  'tour.progress': '{total}లో దశ {step}',
  'tour.skip': 'దాటవేయి',
  'tour.pending': 'చేయవలసినది',

  'tour.step1.title': 'నమూనా workscape తెరవండి',
  'tour.step1.body': 'Q3 Delivery ప్రతి లైబ్రరీలో శాశ్వతంగా ఉంటుంది. ఇందులో ఏదీ విలువైనది కాదు.',
  'tour.step1.action': '“Q3 Delivery — Guided sample” పై డబుల్-క్లిక్ చేయండి',

  'tour.step2.title': 'మరో పట్టికలోని సెల్‌ను సూచించండి',
  'tour.step2.body':
    'ఏదైనా సెల్‌పై డబుల్-క్లిక్ చేసి, = ఆపై @ టైప్ చేసి, ఒక entity ఎంచుకోండి. సెల్ లైవ్‌గా ఉంటుంది — మూలాన్ని మార్చితే అది కూడా మారుతుంది.',
  'tour.step2.note':
    'Numbers: People::B2, ఒక స్థానానికి కట్టుబడి ఉంటుంది. GeDe: =@Entity.Path, వరుసకే కట్టుబడి ఉంటుంది.',
  'tour.step2.action': 'ఏదైనా సెల్‌లో ఒక సూత్రం టైప్ చేయండి',

  'tour.step2.concat.title': '=Concat() తో పాఠ్యాన్ని కలపండి',
  'tour.step2.concat.body':
    'Concat తన ఆర్గ్యుమెంట్‌లను ఒకదాని వెనుక ఒకటిగా కలుపుతుంది: సెల్‌లు, @ పాత్‌లు, కోట్ చేసిన పాఠ్యం — ఏ మిశ్రమంలోనైనా. ఒక ఖాళీ సెల్‌లో =Concat(C5, " — ", @Team.Priya.Role) టైప్ చేసి Enter నొక్కండి; అది Priya — Product engineer అని చూపుతుంది.',
  'tour.step2.concat.note':
    'Numbers: CONCATENATE లేదా &, సాదా స్ట్రింగ్‌లపై. GeDe: =Concat(a, b, …) ప్రతి ఆర్గ్యుమెంట్ గుర్తులను, సూచనలను లైవ్‌గా ఉంచుతుంది; కలిపిన పాఠ్యం తన మూలాలను అనుసరిస్తుంది.',
  'tour.step2.concat.action':
    'రెండు లేదా అంతకంటే ఎక్కువ ఆర్గ్యుమెంట్‌లతో ఒక Concat ను కమిట్ చేయండి',

  'tour.step3.title': 'సెల్‌లలోని పాఠ్యంపై లెక్కించండి',
  'tour.step3.body':
    'సెల్‌లోని కామాలు ఒక సెట్‌ను చేస్తాయి; ఐదు రూపాలు సెట్‌లను పోలుస్తాయి. Deliverables లోని ఒక ఖాళీ సెల్‌పై డబుల్-క్లిక్ చేసి, రూపాల మెనూ తెరవడానికి = టైప్ చేసి, Union(a, b, …) ఎంచుకోండి. కుండలీకరణాల లోపల రెండు పరిధులను రాయండి: =Union(C5:C12, I5:I8) అంటే owner గా లేదా టీమ్‌లో పేరున్న ప్రతి ఒక్కరూ, ఒక్కసారే — Priya, Marcus, Aditi, Sanjay.',
  'tour.step3.note':
    'Numbers లో దీనికి సమానమైనది లేదు — సెల్‌లోని కామాలు ఒక సెట్‌ను చేస్తాయి, సెట్ సూత్రం ఫలితం తన మూలాల్లాగే చదివే ఒకే సెల్.',
  'tour.step3.action': 'ఒక సెల్‌లో = టైప్ చేసి Union ఎంచుకోండి',

  'tour.step3.result.title': 'రెండు సెట్‌లను పోల్చండి',
  'tour.step3.result.body':
    'Diff మొదటి సెట్‌లో ఉండి రెండవదానిలో లేనివాటిని ఉంచుతుంది. టీమ్‌లో Billing export ను ఇంకా ఎవరు తీసుకోగలరు? మరో ఖాళీ సెల్‌లో =Diff(I5:I8, C6) టైప్ చేసి Enter నొక్కండి: ఆ వరుస owner ను మినహాయించిన టీమ్ — Priya, Aditi, Sanjay. Inter రెండింటిలో ఉన్నవాటిని ఉంచుతుంది, Comp సార్వత్రిక సెట్‌లో ఉండి సెట్‌లో లేనివాటిని, Cross ప్రతి జంటను.',
  'tour.step3.result.action':
    'రెండు సెల్‌లు లేదా పరిధులపై ఒక Diff, Inter, Comp లేదా Cross ను కమిట్ చేయండి',

  'tour.step4.title': 'ఒక context graph జోడించండి',
  'tour.step4.body':
    'graph అనేది నిలువు వరుసలకు కట్టుబడిన, canvas పైని వస్తువు. ఒక node క్లిక్ చేస్తే, అది ఆ విలువను వరుసల్లోకి తిరిగి రాస్తుంది.',
  'tour.step4.note':
    'Numbers లో దీనికి సమానమైనది లేదు — ఇది chart కాదు. ఇది పట్టికను చదువుతుంది, రాస్తుంది.',
  'tour.step4.action': 'టూల్‌బార్‌లో Add graph క్లిక్ చేయండి',

  'tour.step4.point.title': 'దాన్ని ఒక పట్టికవైపు చూపండి',
  'tour.step4.point.body':
    'graph తన వరుసలను, నిలువు వరుసలను ఒక పట్టిక నుండి తీసుకుంటుంది. నమూనాలోని రెండు పట్టికలు, Deliverables మరియు Team, లక్ష్యాలుగా అంచుతో గుర్తించబడ్డాయి; ఏదైనా సరిపోతుంది. Escape మళ్లీ మొదలుపెడుతుంది.',
  'tour.step4.point.offCanvas': 'ఒక పట్టిక canvas బయట ఉంది; తెరపై ఉన్నది సరిపోతుంది.',
  'tour.step4.point.action': 'graph ను బంధించడానికి ఒక పట్టికను క్లిక్ చేయండి',

  'tour.step4.dimensions.title': 'కొలతలను ఎంచుకోండి',
  'tour.step4.dimensions.body':
    'కొలత అంటే విలువలు ఒక సందర్భాన్ని నిర్వచించే నిలువు వరుస; కాబట్టి విలువల ప్రతి కలయిక ఒక node. graph మొదట నమోదు చేసిన మూడు నిలువు వరుసలతో మొదలవుతుంది; Graph ట్యాబ్ ప్రతి నిలువు వరుసను దాని విభిన్న విలువలతో జాబితా చేస్తుంది. సెట్‌ను మార్చండి — మూడింటిలో ఒకదాన్ని తీసివేయండి, లేదా మరొకటి టిక్ చేయండి — graph మళ్లీ గీయడం చూడండి.',
  'tour.step4.dimensions.action': 'ఒక కొలతను తీసివేయండి లేదా టిక్ చేయండి, కనీసం రెండు ఉంచుతూ',

  'tour.step5.title': 'ప్రతి పట్టికలో వెతకండి',
  'tour.step5.body':
    'ఒకే శోధన మొత్తం workscape ను కవర్ చేస్తుంది. Operator లు దాన్ని కుదిస్తాయి: col:Owner, is:date.',
  'tour.step5.note':
    'Numbers ఒకసారి ఒక షీట్‌లో మాత్రమే వెతుకుతుంది. ఇక్కడ ⌘F ప్రతి పట్టికలో, graph లో వెతుకుతుంది.',
  'tour.step5.action': 'Find తెరిచి ఏదైనా టైప్ చేయండి',

  'tour.step6.title': 'ఇమెయిల్ ద్వారా ఎవరినైనా ఆహ్వానించండి',
  'tour.step6.body':
    'మీరు ఆహ్వానించిన వారు ఒక workscape ను మొదటిసారి తెరిచినప్పుడు ఇదే మార్గదర్శనం పొందుతారు.',
  'tour.step6.note': 'iCloud షేరింగ్ లాగే, ప్రతి వ్యక్తికి మీరు సెట్ చేసే ఒక అనుమతితో.',
  'tour.step6.action': 'Share తెరిచి ఒక ఇమెయిల్‌ను ఆహ్వానించండి',

  'tour.done.message': 'ఆరూ పూర్తయ్యాయి. మీ లైబ్రరీలోని ? నుండి ఎప్పుడైనా మళ్లీ ప్లే చేయవచ్చు.',
  'tour.done.replay': 'మళ్లీ ప్లే చేయి',

  'object.name.ring': '{table} యొక్క రింగ్',
  'object.name.coverage': '{table} యొక్క కవరేజ్',
  'object.name.pair': '{table} యొక్క గ్రాఫ్',
  'object.name.ringUnbound': 'రింగ్',
  'object.name.coverageUnbound': 'కవరేజ్',
  'object.name.pairUnbound': 'గ్రాఫ్',
  'object.name.tableGraph': '{table} మరియు దాని గ్రాఫ్',
  'object.name.tableGraphs': '{table} మరియు దాని {count} గ్రాఫ్‌లు',
  'object.deleted': '{name} తొలగించబడింది — రద్దు చేయడానికి {undo} నొక్కండి',
  'object.deleted.ref':
    '{name} తొలగించబడింది — వేరే చోట 1 సెల్ ఇప్పుడు “సూచన తొలగించబడింది” అని చూపుతోంది; రద్దు చేయడానికి {undo} నొక్కండి',
  'object.deleted.refs':
    '{name} తొలగించబడింది — వేరే చోట {count} సెల్‌లు ఇప్పుడు “సూచన తొలగించబడింది” అని చూపుతున్నాయి; రద్దు చేయడానికి {undo} నొక్కండి',
  'object.collapsed': '{name} కుదించబడింది',
  'object.expanded': '{name} విస్తరించబడింది',
  'object.collapse': '{name} కుదించు',
  'object.expand': '{name} విస్తరించు',

  'sheet.name.tables': '{tables} ఉన్న {sheet}',
  'sheet.name.graphs': '{graphs} ఉన్న {sheet}',
  'sheet.name.both': '{tables} మరియు {graphs} ఉన్న {sheet}',
  'sheet.count.table': '1 పట్టిక',
  'sheet.count.tables': '{count} పట్టికలు',
  'sheet.count.graph': '1 గ్రాఫ్',
  'sheet.count.graphs': '{count} గ్రాఫ్‌లు',
  'sheet.deleted': '{name} తొలగించబడింది',
  'sheet.nowOn': '{deleted}. ఇప్పుడు {sheet}లో',
  'sheet.removedRemotely': '{sheet} తొలగించబడింది — ఇప్పుడు {nowOn}లో',
  'sheet.renamed': '{from} పేరు {to}గా మార్చబడింది',
  'sheet.restored': '{sheet} పునరుద్ధరించబడింది',
  'sheet.lastKept': 'ఒక workscapeలో కనీసం ఒక షీట్ ఉంటుంది',
  'sheet.needsName': 'షీట్‌కు ఒక పేరు అవసరం',

  'library.help.label': 'సహాయం',
  'library.help.replay': 'గైడెడ్ టూర్ మళ్లీ ప్లే చేయి',
  'library.help.shortcuts': 'కీబోర్డ్ షార్ట్‌కట్‌లు',

  'auth.code.label.six': 'ఆరు అంకెల కోడ్',
  'auth.code.label.eight': 'ఎనిమిది అంకెల కోడ్',
  'auth.code.sent.six': 'మీ ఇమెయిల్‌కు ఆరు అంకెల కోడ్ పంపాము',
  'auth.code.sent.eight': 'మీ ఇమెయిల్‌కు ఎనిమిది అంకెల కోడ్ పంపాము',
  'auth.code.expires.signIn': 'కోడ్‌లు 10 నిమిషాల్లో గడువు ముగుస్తాయి',
  'auth.code.expires.signUp': 'కోడ్‌లు 24 గంటల్లో గడువు ముగుస్తాయి',

  'forms.power.hint': 'a యొక్క ప్రతి ఉపసమితి',

  'set.lost': 'ఇక {sets}లో లేదు',
  'set.readOnly.computed': 'ఈ నిలువు వరుస లెక్కించబడుతుంది',
  'set.rowComputed': 'ఈ వరుస లెక్కించబడుతుంది',
  'cell.readOnly': 'చదవడానికి మాత్రమే: {reason}',
  'cell.readOnly.announce': '{cell} చదవడానికి మాత్రమే: {reason}',
  'cell.readOnly.announceUnaddressed': 'ఈ సెల్ చదవడానికి మాత్రమే: {reason}',
  'column.readOnly.announce': 'నిలువు వరుస {column} చదవడానికి మాత్రమే: {reason}',
  'set.fillRefused': 'నిలువు వరుస {column} నింపబడలేదు: నిలువు వరుస ఖాళీగా లేదు',
  'set.fillSuperseded': 'నిలువు వరుస {column} నింపబడలేదు: పట్టిక మరొక సూత్రాన్ని అనుసరిస్తోంది',
  'readOnly.derived': 'ఉత్పన్న నిలువు వరుస',
  'readOnly.linked': 'లింక్ చేసిన నిలువు వరుస',
  'readOnly.pulled': 'మరొక పట్టిక నుండి తీసుకోబడింది',
  'readOnly.group': 'వర్గ పట్టీ',
  'readOnly.splitChild': 'విభజించిన ఉప వరుస',

  'addTable.title': 'ఇది ఏ రకమైన పట్టిక?',
  'addTable.kinds': 'పట్టిక రకం',
  'addTable.kind.plain': 'సాధారణ పట్టిక',
  'addTable.kind.plain.hint': 'ఒక సాధారణ GeDe పట్టిక. సమితి నియమాలు లేవు, సారాంశ నమోదు లేదు.',
  'addTable.kind.simple': 'సరళ సమితి',
  'addTable.kind.simple.hint': 'అత్యంత ప్రాథమిక సమితి: మూలకాల పరిధి, ప్రతిదానికి ఒక గమనిక.',
  'addTable.kind.family': 'సమితుల కుటుంబం',
  'addTable.kind.family.hint':
    'సమితుల లోపల సమితులు. ఒక వరుసలో ఒక మూలకం, ఒక సరళ సమితి లేదా మరో కుటుంబం ఉంటుంది.',
  'addTable.kind.computed': 'సూత్రంతో లెక్కించినది',
  'addTable.kind.computed.hint':
    'ఈ షీట్‌లో ఇప్పటికే ఉన్న సమితుల సమ్మేళనం, ఖండన లేదా భేదం. వాటితో పాటు మారుతుంది.',
  'addTable.kind.product': 'కార్టీసియన్ లబ్ధం',
  'addTable.kind.product.hint':
    'రెండు లేదా అంతకంటే ఎక్కువ సమితుల నుండి ప్రతి క్రమ యుగ్మం. వరుసలు |A| × |B| × …',
  'addTable.add': 'పట్టికను జోడించు',
  'addTable.pickSets': 'సమితులను ఎంచుకో',
  'addTable.cancel': 'రద్దు చేయి',
  'addTable.back': 'వెనుకకు',
  'addTable.added': '{table} జోడించబడింది',
  'pick.title': 'లెక్కించిన పట్టికను జోడించు',
  'pick.description':
    'ఈ షీట్‌లో ఇప్పటికే ఉన్న సమితుల నుండి. అవి మారినప్పుడు ఫలితం మళ్లీ లెక్కించబడుతుంది.',
  'pick.operation': 'క్రియ',
  'pick.op.Union': 'ఏదైనా సమితిలోని మూలకాలు',
  'pick.op.Inter': 'ప్రతి సమితిలో ఉన్న మూలకాలు',
  'pick.op.Diff': 'b లో లేని a యొక్క మూలకాలు',
  'pick.op.Cross': 'ప్రతి క్రమ యుగ్మం (a, b, …)',
  'pick.sets': 'సమితులు, క్రమంలో',
  'pick.firstSet': 'మొదటి సమితి',
  'pick.secondSet': 'రెండవ సమితి',
  'pick.set': 'సమితి',
  'pick.factor': 'లబ్ధంలో సమితి {n}',
  'pick.removeFactor': 'సమితి {n} తొలగించు',
  'pick.addFactor': 'మరో సమితిని జోడించు',
  'pick.order': 'క్రమం ముఖ్యం: ప్రతి వరుస ఒక క్రమ యుగ్మం. E × E లాగా ఒక సమితి రెండుసార్లు రావచ్చు.',
  'pick.shape': 'ప్రతి యుగ్మం ఎక్కడ',
  'pick.shape.column': 'ఒక నిలువు వరుస',
  'pick.shape.column.hint':
    'ప్రతి గడిలో ఒక యుగ్మం ఉంటుంది, (a, b, x). దీన్ని పెద్ద పట్టికలో ఒక నిలువు వరుసగా వాడండి.',
  'pick.shape.spread': 'ప్రతి సమితికి ఒక నిలువు వరుస',
  'pick.shape.spread.hint':
    'x1, x2, x3 వరుసలోని పక్కపక్క గడుల్లో ఉంటాయి. వాటి పక్కన మీ నిలువు వరుసలను జోడించండి.',
  'pick.formula': 'సూత్రం',
  'pick.noSets': 'ఈ షీట్‌లో ఇంకా సమితులు లేవు. ముందుగా ఒక సరళ సమితిని జోడించండి.',
  'fill.menu': 'నిలువు వరుసను సూత్రంతో నింపు…',
  'fill.title': '{column}ను ఒక సూత్రంతో నింపు',
  'fill.description':
    'ఫలితంలోని ప్రతి మూలకానికి నిలువు వరుస ఒక వరుసను నింపుతుంది; దాని సమితులు మారినప్పుడు మళ్లీ లెక్కించబడుతుంది.',
  'fill.confirm': 'నిలువు వరుసను నింపు',
  'fill.notEmpty': 'నిలువు వరుస ఖాళీగా లేదు',
  'fill.filled': '{column} {formula}తో నింపబడింది',
  'fill.hasFormula': 'పట్టికలో ఇప్పటికే ఒక సూత్రం ఉంది',
  'fill.derived': 'ఈ నిలువు వరుస ఉత్పన్నమైనది',
  'fill.pulled': 'ఈ నిలువు వరుస మరొక పట్టిక నుండి తీసుకోబడింది',
  'fill.linked': 'ఈ నిలువు వరుస ఒక మ్యాపింగ్',
  'kind.typed': 'పట్టికలో టైప్ చేసిన విలువలు ఉన్నాయి',
  'kind.needsFormula': 'ముందుగా ఒక నిలువు వరుసను సూత్రంతో నింపండి',
  'kind.changed': '{table} ఇప్పుడు {kind}',
  'kind.needsCross': 'సూత్రం Cross కాదు',
  'kind.isCross': 'సూత్రం ఒక Cross',
  'kind.computedColumns': 'దీని నిలువు వరుసలు సూత్రం నుండి నిండుతాయి',
  'kind.section': 'రకం',
  'kind.section.hint': 'ఏ గడిలోనూ టైప్ చేసిన విలువ లేనప్పుడు మారుతుంది.',
  'set.column.range': 'పరిధి',
  'set.column.description': 'వివరణ',
  'set.column.note': 'గమనిక',
};
