import type { Messages } from './types.js';

/** తెలుగు (India). Product names (GeDe, workscape, passkey) stay as written. */
export const messages: Messages = {
  'signUpCode.subject': 'మీ GeDe సైన్-అప్ కోడ్',
  'signUpCode.heading': 'మీ ఇమెయిల్ చిరునామాను నిర్ధారించండి',
  'signUpCode.body': 'మీ ఖాతా సృష్టిని పూర్తి చేయడానికి ఈ కోడ్‌ను GeDe-లో నమోదు చేయండి.',
  'signUpCode.expires': 'ఈ కోడ్ ఒకసారి మాత్రమే పనిచేస్తుంది; 24 గంటల్లో గడువు ముగుస్తుంది.',
  'signUpCode.why':
    'ఈ చిరునామాతో ఒక GeDe ఖాతా సృష్టించబడినందున ఈ ఇమెయిల్ మీకు వచ్చింది. అది మీరు కాకపోతే, ఈ ఇమెయిల్‌ను విస్మరించండి; కోడ్ లేకుండా ఏదీ మారదు.',

  'signInCode.subject': 'మీ GeDe సైన్-ఇన్ కోడ్',
  'signInCode.heading': 'GeDe-లో సైన్ ఇన్ చేయండి',
  'signInCode.body': 'సైన్ ఇన్ చేయడానికి ఈ కోడ్‌ను నమోదు చేయండి.',
  'signInCode.expires': 'ఈ కోడ్ ఒకసారి మాత్రమే పనిచేస్తుంది; 10 నిమిషాల్లో గడువు ముగుస్తుంది.',
  'signInCode.why':
    'ఈ చిరునామాతో GeDe-లో సైన్ ఇన్ చేయమని ఎవరో అభ్యర్థించినందున ఈ ఇమెయిల్ మీకు వచ్చింది. అది మీరు కాకపోతే, ఈ ఇమెయిల్‌ను విస్మరించండి; కోడ్ లేకుండా ఏదీ మారదు.',

  'emailChangeCode.subject': 'మీ కొత్త GeDe ఇమెయిల్ చిరునామాను నిర్ధారించండి',
  'emailChangeCode.heading': 'మీ కొత్త ఇమెయిల్ చిరునామాను నిర్ధారించండి',
  'emailChangeCode.body':
    'మార్పును నిర్ధారించడానికి ఈ కోడ్‌ను GeDe-లో నమోదు చేయండి. అప్పటివరకు మీ మునుపటి చిరునామా పనిచేస్తూనే ఉంటుంది.',
  'emailChangeCode.expires': 'ఈ కోడ్ ఒకసారి మాత్రమే పనిచేస్తుంది; 24 గంటల్లో గడువు ముగుస్తుంది.',
  'emailChangeCode.why':
    'ఒక GeDe ఖాతా ఈ చిరునామాకు మారమని అభ్యర్థించినందున ఈ ఇమెయిల్ మీకు వచ్చింది. అది మీరు కాకపోతే, ఈ ఇమెయిల్‌ను విస్మరించండి; కోడ్ లేకుండా ఏదీ మారదు.',

  'code.label': 'మీ కోడ్',

  'share.member.subject': '{actor} “{title}”ను మీతో పంచుకున్నారు',
  'share.member.heading': '{actor} ఒక workscape-ను మీతో పంచుకున్నారు',
  'share.member.body': '{actor} GeDe-లో “{title}” అనే workscape-ను మీతో పంచుకున్నారు.',
  'share.member.next':
    'కింది బటన్‌తో దాన్ని తెరవండి. మీ passkey లేదా ఈ చిరునామాకు పంపిన కోడ్‌తో సైన్ ఇన్ చేయండి.',
  'share.member.action': 'workscape-ను తెరవండి',
  'share.member.why':
    '{actor} GeDe-లో ఒక workscape-ను ఈ చిరునామాతో పంచుకున్నందున ఈ ఇమెయిల్ మీకు వచ్చింది.',

  'share.invite.subject': '{actor} మిమ్మల్ని ఒక GeDe workscape-కు ఆహ్వానించారు',
  'share.invite.heading': '{actor} మిమ్మల్ని ఒక workscape-కు ఆహ్వానించారు',
  'share.invite.body': '{actor} మిమ్మల్ని GeDe-లో “{title}” అనే workscape-కు ఆహ్వానించారు.',
  'share.invite.next':
    'ఈ ఆహ్వానం {days} రోజుల పాటు చెల్లుతుంది. కింది బటన్‌తో దాన్ని అంగీకరించి, ఆపై ఈ చిరునామాతో మీ ఖాతాను సృష్టించండి: GeDe passkey లేదా ఇమెయిల్ కోడ్‌తో సైన్ ఇన్ చేస్తుంది కాబట్టి ఎంచుకోవలసిన పాస్‌వర్డ్ ఏదీ లేదు.',
  'share.invite.action': 'ఆహ్వానాన్ని అంగీకరించండి',
  'share.invite.why':
    '{actor} GeDe-లో ఈ చిరునామాను ఒక workscape-కు ఆహ్వానించినందున ఈ ఇమెయిల్ మీకు వచ్చింది.',

  'share.someone': 'ఎవరో',

  'layout.linkFallback': 'బటన్ తెరవకపోతే, ఈ లింక్‌ను మీ బ్రౌజర్‌లో తెరవండి:',
  'layout.sentTo': 'ఈ ఇమెయిల్ {email}కు పంపబడింది.',
  'layout.footer': 'GeDe, పాఠ్య-ఆధారిత స్ప్రెడ్‌షీట్.',
};
