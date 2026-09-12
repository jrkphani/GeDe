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

  'tour.step3.title': 'ఒక context graph జోడించండి',
  'tour.step3.body':
    'graph అనేది నిలువు వరుసలకు కట్టుబడిన, canvas పైని వస్తువు. ఒక node క్లిక్ చేస్తే, అది ఆ విలువను వరుసల్లోకి తిరిగి రాస్తుంది.',
  'tour.step3.note':
    'Numbers లో దీనికి సమానమైనది లేదు — ఇది chart కాదు. ఇది పట్టికను చదువుతుంది, రాస్తుంది.',
  'tour.step3.action': 'టూల్‌బార్‌లో Add graph క్లిక్ చేయండి',

  'tour.step4.title': 'ప్రతి పట్టికలో వెతకండి',
  'tour.step4.body':
    'ఒకే శోధన మొత్తం workscape ను కవర్ చేస్తుంది. Operator లు దాన్ని కుదిస్తాయి: col:Owner, is:date.',
  'tour.step4.note':
    'Numbers ఒకసారి ఒక షీట్‌లో మాత్రమే వెతుకుతుంది. ఇక్కడ ⌘F ప్రతి పట్టికలో, graph లో వెతుకుతుంది.',
  'tour.step4.action': 'Find తెరిచి ఏదైనా టైప్ చేయండి',

  'tour.step5.title': 'ఇమెయిల్ ద్వారా ఎవరినైనా ఆహ్వానించండి',
  'tour.step5.body':
    'మీరు ఆహ్వానించిన వారు ఒక workscape ను మొదటిసారి తెరిచినప్పుడు ఇదే మార్గదర్శనం పొందుతారు.',
  'tour.step5.note': 'iCloud షేరింగ్ లాగే, ప్రతి పట్టికకు విడిగా అనుమతులు సెట్ చేయవచ్చు.',
  'tour.step5.action': 'Share తెరిచి ఒక ఇమెయిల్‌ను ఆహ్వానించండి',

  'tour.done.message': 'ఐదూ పూర్తయ్యాయి. మీ లైబ్రరీలోని ? నుండి ఎప్పుడైనా మళ్లీ ప్లే చేయవచ్చు.',
  'tour.done.replay': 'మళ్లీ ప్లే చేయి',

  'library.help.label': 'సహాయం',
  'library.help.replay': 'గైడెడ్ టూర్ మళ్లీ ప్లే చేయి',
  'library.help.shortcuts': 'కీబోర్డ్ షార్ట్‌కట్‌లు',
};
