import type { Messages } from './messages.js';

/** हिन्दी (India). Product names (GeDe, Numbers, iCloud, workscape) and typed tokens stay as written. */
export const messages: Messages = {
  'tour.counter': 'चरण {step} / {total}',
  'tour.progress': '{total} में से चरण {step}',
  'tour.skip': 'छोड़ें',
  'tour.pending': 'अपेक्षित कार्य',

  'tour.step1.title': 'नमूना workscape खोलें',
  'tour.step1.body':
    'Q3 Delivery हर लाइब्रेरी में स्थायी रूप से रहता है। इसमें कुछ भी कीमती नहीं है।',
  'tour.step1.action': '“Q3 Delivery — Guided sample” पर डबल-क्लिक करें',

  'tour.step2.title': 'दूसरी तालिका के किसी सेल का संदर्भ दें',
  'tour.step2.body':
    'किसी भी सेल पर डबल-क्लिक करें, = और फिर @ टाइप करें, और एक entity चुनें। सेल लाइव रहता है — स्रोत बदलें तो वह भी बदल जाता है।',
  'tour.step2.note':
    'Numbers: People::B2, एक स्थिति से बंधा। GeDe: =@Entity.Path, स्वयं पंक्ति से बंधा।',
  'tour.step2.action': 'किसी भी सेल में एक सूत्र टाइप करें',

  'tour.step2.concat.title': '=Concat() से पाठ जोड़ें',
  'tour.step2.concat.body':
    'Concat अपने तर्कों को एक के बाद एक जोड़ता है: सेल, @ पथ और उद्धृत पाठ, किसी भी मिश्रण में। किसी खाली सेल में =Concat(C5, " — ", @Team.Priya.Role) टाइप करें और Enter दबाएँ; इसका मान Priya — Product engineer होता है।',
  'tour.step2.concat.note':
    'Numbers: CONCATENATE या &, सादे स्ट्रिंग पर। GeDe: =Concat(a, b, …) हर तर्क के चिह्न और संदर्भ लाइव रखता है, इसलिए जुड़ा हुआ पाठ अपने स्रोतों के साथ बदलता है।',
  'tour.step2.concat.action': 'दो या अधिक तर्कों वाला एक Concat कमिट करें',

  'tour.step3.title': 'सेल के पाठ पर गणना करें',
  'tour.step3.body':
    'सेल के अल्पविराम एक सेट बनाते हैं; पाँच रूप सेटों की तुलना करते हैं। Deliverables के किसी खाली सेल पर डबल-क्लिक करें, रूपों का मेनू खोलने के लिए = टाइप करें और Union(a, b, …) चुनें। कोष्ठक के भीतर दो रेंज लिखें: =Union(C5:C12, I5:I8) यानी हर वह नाम जो owner के रूप में या टीम में है, एक-एक बार — Priya, Marcus, Aditi, Sanjay।',
  'tour.step3.note':
    'Numbers में इसका कोई समकक्ष नहीं — सेल के अल्पविराम एक सेट बनाते हैं, और सेट सूत्र का परिणाम एक ही सेल है जो अपने स्रोतों की तरह पढ़ा जाता है।',
  'tour.step3.action': 'किसी सेल में = टाइप करें और Union चुनें',

  'tour.step3.result.title': 'दो सेटों की तुलना करें',
  'tour.step3.result.body':
    'Diff वह रखता है जो पहले सेट में है और दूसरे में नहीं। टीम में और कौन Billing export ले सकता है? किसी दूसरे खाली सेल में =Diff(I5:I8, C6) टाइप करें और Enter दबाएँ: उस पंक्ति के owner को छोड़कर टीम — Priya, Aditi, Sanjay। Inter वह रखता है जो दोनों में है, Comp वह जो सार्वत्रिक सेट में है और सेट में नहीं, Cross हर जोड़ा।',
  'tour.step3.result.action': 'दो सेल या रेंज पर एक Diff, Inter, Comp या Cross कमिट करें',

  'tour.step4.title': 'एक context graph जोड़ें',
  'tour.step4.body':
    'graph कैनवस पर एक वस्तु है जो स्तंभों से बंधी होती है। किसी node पर क्लिक करें और वह उस मान को पंक्तियों में वापस लिख देता है।',
  'tour.step4.note':
    'Numbers में इसका कोई समकक्ष नहीं — यह चार्ट नहीं है। यह तालिका को पढ़ता और लिखता है।',
  'tour.step4.action': 'टूलबार में Add graph पर क्लिक करें',

  'tour.step4.point.title': 'इसे किसी तालिका की ओर इंगित करें',
  'tour.step4.point.body':
    'graph अपनी पंक्तियाँ और स्तंभ एक तालिका से लेता है। नमूने की दोनों तालिकाएँ, Deliverables और Team, लक्ष्य के रूप में रेखांकित हैं; कोई भी चलेगी। Escape फिर से शुरू करता है।',
  'tour.step4.point.offCanvas': 'एक तालिका कैनवस से बाहर है; जो स्क्रीन पर है वह पर्याप्त है।',
  'tour.step4.point.action': 'graph को बाँधने के लिए किसी तालिका पर क्लिक करें',

  'tour.step4.dimensions.title': 'आयाम चुनें',
  'tour.step4.dimensions.body':
    'आयाम वह स्तंभ है जिसके मान एक संदर्भ तय करते हैं, इसलिए मानों का हर संयोजन एक node है। graph पहले तीन दर्ज किए गए स्तंभों से शुरू होता है; Graph टैब हर स्तंभ को उसके अलग-अलग मानों के साथ सूचीबद्ध करता है। सेट बदलें — तीन में से एक हटाएँ, या कोई और टिक करें — और graph फिर से बनते देखें।',
  'tour.step4.dimensions.action': 'किसी आयाम को हटाएँ या टिक करें, कम से कम दो रखते हुए',

  'tour.step5.title': 'हर तालिका में खोजें',
  'tour.step5.body':
    'एक खोज पूरे workscape को कवर करती है। Operator इसे सीमित करते हैं: col:Owner, is:date.',
  'tour.step5.note':
    'Numbers एक समय में एक ही शीट खोजता है। यहाँ ⌘F हर तालिका और graph में खोजता है।',
  'tour.step5.action': 'Find खोलें और कुछ भी टाइप करें',

  'tour.step6.title': 'ईमेल से किसी को आमंत्रित करें',
  'tour.step6.body':
    'जिन्हें आप आमंत्रित करते हैं, उन्हें पहली बार workscape खोलने पर यही मार्गदर्शन मिलता है।',
  'tour.step6.note': 'iCloud साझाकरण की तरह, एक अनुमति के साथ जो आप हर व्यक्ति के लिए तय करते हैं।',
  'tour.step6.action': 'Share खोलें और एक ईमेल आमंत्रित करें',

  'tour.done.message': 'छहों पूरे हुए। अपनी लाइब्रेरी में ? से कभी भी दोबारा चलाएँ।',
  'tour.done.replay': 'दोबारा चलाएँ',

  'object.name.ring': '{table} का वलय',
  'object.name.coverage': '{table} का कवरेज',
  'object.name.pair': '{table} का ग्राफ़',
  'object.name.ringUnbound': 'वलय',
  'object.name.coverageUnbound': 'कवरेज',
  'object.name.pairUnbound': 'ग्राफ़',
  'object.name.tableGraph': '{table} और उसका ग्राफ़',
  'object.name.tableGraphs': '{table} और उसके {count} ग्राफ़',
  'object.deleted': '{name} हटाया गया — पूर्ववत करने के लिए {undo} दबाएँ',
  'object.deleted.ref':
    '{name} हटाया गया — अन्यत्र 1 सेल अब “संदर्भ हटाया गया” दिखाता है; पूर्ववत करने के लिए {undo} दबाएँ',
  'object.deleted.refs':
    '{name} हटाया गया — अन्यत्र {count} सेल अब “संदर्भ हटाया गया” दिखाते हैं; पूर्ववत करने के लिए {undo} दबाएँ',
  'object.collapsed': '{name} समेटा गया',
  'object.expanded': '{name} फैलाया गया',
  'object.collapse': '{name} समेटें',
  'object.expand': '{name} फैलाएँ',

  'sheet.name.tables': '{tables} वाली {sheet}',
  'sheet.name.graphs': '{graphs} वाली {sheet}',
  'sheet.name.both': '{tables} और {graphs} वाली {sheet}',
  'sheet.count.table': '1 तालिका',
  'sheet.count.tables': '{count} तालिकाएँ',
  'sheet.count.graph': '1 ग्राफ़',
  'sheet.count.graphs': '{count} ग्राफ़',
  'sheet.deleted': '{name} हटाई गई',
  'sheet.nowOn': '{deleted}. अब {sheet} पर',
  'sheet.removedRemotely': '{sheet} हटाई गई — अब {nowOn} पर',
  'sheet.renamed': '{from} का नाम बदलकर {to} किया गया',
  'sheet.restored': '{sheet} पुनर्स्थापित की गई',
  'sheet.lastKept': 'एक workscape में कम से कम एक शीट रहती है',
  'sheet.needsName': 'शीट का एक नाम होना चाहिए',

  'library.help.label': 'सहायता',
  'library.help.replay': 'निर्देशित टूर दोबारा चलाएँ',
  'library.help.shortcuts': 'कीबोर्ड शॉर्टकट',

  'auth.code.label.six': 'छह अंकों का कोड',
  'auth.code.label.eight': 'आठ अंकों का कोड',
  'auth.code.sent.six': 'हमने आपके ईमेल पर छह अंकों का कोड भेजा है',
  'auth.code.sent.eight': 'हमने आपके ईमेल पर आठ अंकों का कोड भेजा है',
  'auth.code.expires.signIn': 'कोड 10 मिनट में समाप्त हो जाते हैं',
  'auth.code.expires.signUp': 'कोड 24 घंटे में समाप्त हो जाते हैं',
};
