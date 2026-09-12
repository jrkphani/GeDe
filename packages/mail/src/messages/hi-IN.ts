import type { Messages } from './types.js';

/** हिन्दी (India). Product names (GeDe, workscape, passkey) stay as written. */
export const messages: Messages = {
  'signUpCode.subject': 'आपका GeDe साइन-अप कोड',
  'signUpCode.heading': 'अपने ईमेल पते की पुष्टि करें',
  'signUpCode.body': 'अपना खाता बनाना पूरा करने के लिए यह कोड GeDe में दर्ज करें।',
  'signUpCode.expires': 'यह कोड एक बार काम करता है और 24 घंटे में समाप्त हो जाता है।',
  'signUpCode.why':
    'यह ईमेल आपको इसलिए मिला है क्योंकि इस पते से एक GeDe खाता बनाया गया। अगर यह आप नहीं थे, तो इस ईमेल को अनदेखा करें; कोड के बिना कुछ नहीं बदलता।',

  'signInCode.subject': 'आपका GeDe साइन-इन कोड',
  'signInCode.heading': 'GeDe में साइन इन करें',
  'signInCode.body': 'साइन इन करने के लिए यह कोड दर्ज करें।',
  'signInCode.expires': 'यह कोड एक बार काम करता है और 10 मिनट में समाप्त हो जाता है।',
  'signInCode.why':
    'यह ईमेल आपको इसलिए मिला है क्योंकि किसी ने इस पते से GeDe में साइन इन करने का अनुरोध किया। अगर यह आप नहीं थे, तो इस ईमेल को अनदेखा करें; कोड के बिना कुछ नहीं बदलता।',

  'emailChangeCode.subject': 'अपने नए GeDe ईमेल पते की पुष्टि करें',
  'emailChangeCode.heading': 'अपने नए ईमेल पते की पुष्टि करें',
  'emailChangeCode.body':
    'बदलाव की पुष्टि के लिए यह कोड GeDe में दर्ज करें। तब तक आपका पिछला पता काम करता रहेगा।',
  'emailChangeCode.expires': 'यह कोड एक बार काम करता है और 24 घंटे में समाप्त हो जाता है।',
  'emailChangeCode.why':
    'यह ईमेल आपको इसलिए मिला है क्योंकि एक GeDe खाते ने इस पते पर बदलने का अनुरोध किया। अगर यह आप नहीं थे, तो इस ईमेल को अनदेखा करें; कोड के बिना कुछ नहीं बदलता।',

  'code.label': 'आपका कोड',

  'share.member.subject': '{actor} ने “{title}” आपके साथ साझा किया',
  'share.member.heading': '{actor} ने एक workscape आपके साथ साझा किया',
  'share.member.body': '{actor} ने GeDe पर workscape “{title}” आपके साथ साझा किया।',
  'share.member.next':
    'इसे नीचे दिए बटन से खोलें। अपनी passkey या इस पते पर भेजे गए कोड से साइन इन करें।',
  'share.member.action': 'workscape खोलें',
  'share.member.why':
    'यह ईमेल आपको इसलिए मिला है क्योंकि {actor} ने GeDe पर एक workscape इस पते के साथ साझा किया।',

  'share.invite.subject': '{actor} ने आपको एक GeDe workscape में आमंत्रित किया',
  'share.invite.heading': '{actor} ने आपको एक workscape में आमंत्रित किया',
  'share.invite.body': '{actor} ने आपको GeDe पर workscape “{title}” में आमंत्रित किया।',
  'share.invite.next':
    'यह आमंत्रण {days} दिनों तक मान्य है। इसे नीचे दिए बटन से स्वीकार करें, फिर इसी पते से अपना खाता बनाएँ: GeDe passkey या ईमेल कोड से साइन इन करता है, इसलिए कोई पासवर्ड चुनना नहीं है।',
  'share.invite.action': 'आमंत्रण स्वीकार करें',
  'share.invite.why':
    'यह ईमेल आपको इसलिए मिला है क्योंकि {actor} ने GeDe पर इस पते को एक workscape में आमंत्रित किया।',

  // Stands where a name would: "किसी ने … साझा किया".
  'share.someone': 'किसी',

  'layout.linkFallback': 'अगर बटन नहीं खुलता, तो यह लिंक अपने ब्राउज़र में खोलें:',
  'layout.sentTo': 'यह ईमेल {email} को भेजा गया।',
  'layout.footer': 'GeDe, पाठ-आधारित स्प्रेडशीट।',
};
