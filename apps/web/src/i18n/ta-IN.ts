import type { Messages } from './messages.js';

/** தமிழ் (India). Product names (GeDe, Numbers, iCloud, workscape) and typed tokens stay as written. */
export const messages: Messages = {
  'tour.counter': 'படி {step} / {total}',
  'tour.progress': '{total}-இல் படி {step}',
  'tour.skip': 'தவிர்',
  'tour.pending': 'செய்ய வேண்டியது',

  'tour.step1.title': 'மாதிரி workscape-ஐத் திறக்கவும்',
  'tour.step1.body':
    'Q3 Delivery ஒவ்வொரு நூலகத்திலும் நிரந்தரமாக இருக்கும். அதில் எதுவும் விலைமதிப்பானது அல்ல.',
  'tour.step1.action': '“Q3 Delivery — Guided sample” மீது இருமுறை கிளிக் செய்யவும்',

  'tour.step2.title': 'மற்றொரு அட்டவணையில் உள்ள கலத்தைக் குறிப்பிடவும்',
  'tour.step2.body':
    'ஏதேனும் ஒரு கலத்தில் இருமுறை கிளிக் செய்து, = பின்னர் @ எனத் தட்டச்சு செய்து, ஒரு entity-ஐத் தேர்வு செய்யவும். கலம் நேரடியாகவே இருக்கும் — மூலத்தை மாற்றினால் அது பின்பற்றும்.',
  'tour.step2.note':
    'Numbers: People::B2, ஒரு நிலையுடன் பிணைக்கப்பட்டது. GeDe: =@Entity.Path, வரிசையுடனேயே பிணைக்கப்பட்டது.',
  'tour.step2.action': 'ஏதேனும் ஒரு கலத்தில் ஒரு சூத்திரத்தைத் தட்டச்சு செய்யவும்',

  'tour.step3.title': 'ஒரு context graph-ஐச் சேர்க்கவும்',
  'tour.step3.body':
    'graph என்பது நெடுவரிசைகளுடன் பிணைக்கப்பட்ட, canvas-இல் உள்ள ஒரு பொருள். ஒரு node-ஐக் கிளிக் செய்தால், அது அந்த மதிப்பை வரிசைகளில் திரும்ப எழுதும்.',
  'tour.step3.note':
    'Numbers-இல் இதற்கு இணை இல்லை — இது ஒரு chart அல்ல. இது அட்டவணையைப் படிக்கிறது, எழுதுகிறது.',
  'tour.step3.action': 'கருவிப்பட்டியில் Add graph-ஐக் கிளிக் செய்யவும்',

  'tour.step4.title': 'எல்லா அட்டவணைகளிலும் தேடவும்',
  'tour.step4.body':
    'ஒரே தேடல் முழு workscape-ஐயும் உள்ளடக்கும். Operator-கள் அதைச் சுருக்கும்: col:Owner, is:date.',
  'tour.step4.note':
    'Numbers ஒரு நேரத்தில் ஒரு தாளில் மட்டுமே தேடும். இங்கே ⌘F ஒவ்வொரு அட்டவணையையும் graph-ஐயும் உள்ளடக்கும்.',
  'tour.step4.action': 'Find-ஐத் திறந்து எதையாவது தட்டச்சு செய்யவும்',

  'tour.step5.title': 'மின்னஞ்சல் மூலம் ஒருவரை அழைக்கவும்',
  'tour.step5.body':
    'நீங்கள் அழைப்பவர்கள் ஒரு workscape-ஐ முதன்முறையாகத் திறக்கும்போது இதே வழிகாட்டியைப் பெறுவார்கள்.',
  'tour.step5.note':
    'iCloud பகிர்வைப் போலவே, ஒவ்வொரு நபருக்கும் நீங்கள் அமைக்கும் ஒரு அனுமதியுடன்.',
  'tour.step5.action': 'Share-ஐத் திறந்து ஒரு மின்னஞ்சலை அழைக்கவும்',

  'tour.done.message':
    'ஐந்தும் முடிந்தது. உங்கள் நூலகத்தில் உள்ள ? இலிருந்து எப்போது வேண்டுமானாலும் மீண்டும் இயக்கலாம்.',
  'tour.done.replay': 'மீண்டும் இயக்கு',

  'library.help.label': 'உதவி',
  'library.help.replay': 'வழிகாட்டிச் சுற்றை மீண்டும் இயக்கு',
  'library.help.shortcuts': 'விசைப்பலகைக் குறுக்குவழிகள்',
};
