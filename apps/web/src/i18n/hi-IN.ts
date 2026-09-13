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

  'tour.step3.title': 'एक context graph जोड़ें',
  'tour.step3.body':
    'graph कैनवस पर एक वस्तु है जो स्तंभों से बंधी होती है। किसी node पर क्लिक करें और वह उस मान को पंक्तियों में वापस लिख देता है।',
  'tour.step3.note':
    'Numbers में इसका कोई समकक्ष नहीं — यह चार्ट नहीं है। यह तालिका को पढ़ता और लिखता है।',
  'tour.step3.action': 'टूलबार में Add graph पर क्लिक करें',

  'tour.step3.point.title': 'इसे किसी तालिका की ओर इंगित करें',
  'tour.step3.point.body':
    'graph अपनी पंक्तियाँ और स्तंभ एक तालिका से लेता है। नमूने की दोनों तालिकाएँ, Deliverables और Team, लक्ष्य के रूप में रेखांकित हैं; कोई भी चलेगी। Escape फिर से शुरू करता है।',
  'tour.step3.point.offCanvas': 'एक तालिका कैनवस से बाहर है; जो स्क्रीन पर है वह पर्याप्त है।',
  'tour.step3.point.action': 'graph को बाँधने के लिए किसी तालिका पर क्लिक करें',

  'tour.step3.dimensions.title': 'आयाम चुनें',
  'tour.step3.dimensions.body':
    'आयाम वह स्तंभ है जिसके मान एक संदर्भ तय करते हैं, इसलिए मानों का हर संयोजन एक node है। graph पहले तीन दर्ज किए गए स्तंभों से शुरू होता है; Graph टैब हर स्तंभ को उसके अलग-अलग मानों के साथ सूचीबद्ध करता है।',
  'tour.step3.dimensions.action': 'Graph टैब में कम से कम दो आयाम टिक करें',

  'tour.step4.title': 'हर तालिका में खोजें',
  'tour.step4.body':
    'एक खोज पूरे workscape को कवर करती है। Operator इसे सीमित करते हैं: col:Owner, is:date.',
  'tour.step4.note':
    'Numbers एक समय में एक ही शीट खोजता है। यहाँ ⌘F हर तालिका और graph में खोजता है।',
  'tour.step4.action': 'Find खोलें और कुछ भी टाइप करें',

  'tour.step5.title': 'ईमेल से किसी को आमंत्रित करें',
  'tour.step5.body':
    'जिन्हें आप आमंत्रित करते हैं, उन्हें पहली बार workscape खोलने पर यही मार्गदर्शन मिलता है।',
  'tour.step5.note': 'iCloud साझाकरण की तरह, एक अनुमति के साथ जो आप हर व्यक्ति के लिए तय करते हैं।',
  'tour.step5.action': 'Share खोलें और एक ईमेल आमंत्रित करें',

  'tour.done.message': 'पाँचों पूरे हुए। अपनी लाइब्रेरी में ? से कभी भी दोबारा चलाएँ।',
  'tour.done.replay': 'दोबारा चलाएँ',

  'library.help.label': 'सहायता',
  'library.help.replay': 'निर्देशित टूर दोबारा चलाएँ',
  'library.help.shortcuts': 'कीबोर्ड शॉर्टकट',
};
