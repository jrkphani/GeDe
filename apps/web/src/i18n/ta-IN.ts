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

  'tour.step2.concat.title': '=Concat() மூலம் உரையை இணைக்கவும்',
  'tour.step2.concat.body':
    'Concat தன் அளவுருக்களை ஒன்றன் பின் ஒன்றாக இணைக்கும்: கலங்கள், @ பாதைகள், மேற்கோளிட்ட உரை — எந்தக் கலவையிலும். ஒரு வெற்றுக் கலத்தில் =Concat(C5, " — ", @Team.Priya.Role) எனத் தட்டச்சு செய்து Enter அழுத்தவும்; அது Priya — Product engineer எனக் காட்டும்.',
  'tour.step2.concat.note':
    'Numbers: CONCATENATE அல்லது &, வெற்று சரங்களின் மீது. GeDe: =Concat(a, b, …) ஒவ்வொரு அளவுருவின் குறிகளையும் குறிப்புகளையும் நேரடியாக வைத்திருக்கும்; இணைந்த உரை தன் மூலங்களைப் பின்பற்றும்.',
  'tour.step2.concat.action':
    'இரண்டு அல்லது அதற்கு மேற்பட்ட அளவுருக்களுடன் ஒரு Concat-ஐ உறுதிசெய்யவும்',

  'tour.step3.title': 'கலங்களில் உள்ள உரையின் மீது கணக்கிடவும்',
  'tour.step3.body':
    'ஒரு கலத்தின் காற்புள்ளிகள் ஒரு தொகுப்பை உருவாக்கும்; ஐந்து வடிவங்கள் தொகுப்புகளை ஒப்பிடும். Deliverables-இல் ஒரு வெற்றுக் கலத்தில் இருமுறை கிளிக் செய்து, வடிவங்கள் பட்டியலைத் திறக்க = எனத் தட்டச்சு செய்து, Union(a, b, …)-ஐத் தேர்வு செய்யவும். அடைப்புக்குறிக்குள் இரண்டு வரம்புகளைக் குறிப்பிடவும்: =Union(C5:C12, I5:I8) என்பது உரிமையாளராகவோ குழுவிலோ பெயரிடப்பட்ட ஒவ்வொருவரும், ஒரே ஒரு முறை — Priya, Marcus, Aditi, Sanjay.',
  'tour.step3.note':
    'Numbers-இல் இதற்கு இணை இல்லை — ஒரு கலத்தின் காற்புள்ளிகள் ஒரு தொகுப்பை உருவாக்கும்; தொகுப்புச் சூத்திரத்தின் முடிவு தன் மூலங்களைப் போலவே படிக்கும் ஒரே ஒரு கலம்.',
  'tour.step3.action': 'ஒரு கலத்தில் = எனத் தட்டச்சு செய்து Union-ஐத் தேர்வு செய்யவும்',

  'tour.step3.result.title': 'இரண்டு தொகுப்புகளை ஒப்பிடவும்',
  'tour.step3.result.body':
    'Diff முதல் தொகுப்பில் இருந்து இரண்டாவதில் இல்லாதவற்றை வைத்திருக்கும். Billing export-ஐ குழுவில் வேறு யார் எடுக்கலாம்? மற்றொரு வெற்றுக் கலத்தில் =Diff(I5:I8, C6) எனத் தட்டச்சு செய்து Enter அழுத்தவும்: அந்த வரிசையின் உரிமையாளரைத் தவிர்த்த குழு — Priya, Aditi, Sanjay. Inter இரண்டிலும் உள்ளவற்றை வைத்திருக்கும்; Comp முழுத் தொகுப்பில் இருந்து ஒரு தொகுப்பில் இல்லாதவற்றை; Cross ஒவ்வொரு இணையையும்.',
  'tour.step3.result.action':
    'இரண்டு கலங்கள் அல்லது வரம்புகளின் மீது ஒரு Diff, Inter, Comp அல்லது Cross-ஐ உறுதிசெய்யவும்',

  'tour.step4.title': 'ஒரு context graph-ஐச் சேர்க்கவும்',
  'tour.step4.body':
    'graph என்பது நெடுவரிசைகளுடன் பிணைக்கப்பட்ட, canvas-இல் உள்ள ஒரு பொருள். ஒரு node-ஐக் கிளிக் செய்தால், அது அந்த மதிப்பை வரிசைகளில் திரும்ப எழுதும்.',
  'tour.step4.note':
    'Numbers-இல் இதற்கு இணை இல்லை — இது ஒரு chart அல்ல. இது அட்டவணையைப் படிக்கிறது, எழுதுகிறது.',
  'tour.step4.action': 'கருவிப்பட்டியில் Add graph-ஐக் கிளிக் செய்யவும்',

  'tour.step4.point.title': 'அதை ஒரு அட்டவணையை நோக்கிச் சுட்டவும்',
  'tour.step4.point.body':
    'graph தன் வரிசைகளையும் நெடுவரிசைகளையும் ஒரு அட்டவணையிலிருந்து எடுக்கும். மாதிரியின் இரு அட்டவணைகளான Deliverables, Team ஆகியவை இலக்குகளாக விளிம்பிடப்பட்டுள்ளன; எதுவும் போதும். Escape மீண்டும் தொடங்கும்.',
  'tour.step4.point.offCanvas': 'ஒரு அட்டவணை canvas-க்கு வெளியே உள்ளது; திரையில் இருப்பது போதும்.',
  'tour.step4.point.action': 'graph-ஐப் பிணைக்க ஒரு அட்டவணையைக் கிளிக் செய்யவும்',

  'tour.step4.dimensions.title': 'பரிமாணங்களைத் தேர்வு செய்யவும்',
  'tour.step4.dimensions.body':
    'ஒரு பரிமாணம் என்பது சூழலை வரையறுக்கும் மதிப்புகளைக் கொண்ட நெடுவரிசை; எனவே மதிப்புகளின் ஒவ்வொரு சேர்க்கையும் ஒரு node. graph முதலில் உள்ளிடப்பட்ட மூன்று நெடுவரிசைகளுடன் தொடங்கும்; Graph தாவல் ஒவ்வொரு நெடுவரிசையையும் அதன் தனித்த மதிப்புகளுடன் பட்டியலிடும். தொகுப்பை மாற்றுங்கள் — மூன்றில் ஒன்றை நீக்கவும், அல்லது வேறொன்றைத் தேர்வு செய்யவும் — graph மீண்டும் வரையப்படுவதைக் காணலாம்.',
  'tour.step4.dimensions.action':
    'ஒரு பரிமாணத்தை நீக்கவும் அல்லது தேர்வு செய்யவும், குறைந்தது இரண்டை வைத்துக்கொண்டு',

  'tour.step5.title': 'எல்லா அட்டவணைகளிலும் தேடவும்',
  'tour.step5.body':
    'ஒரே தேடல் முழு workscape-ஐயும் உள்ளடக்கும். Operator-கள் அதைச் சுருக்கும்: col:Owner, is:date.',
  'tour.step5.note':
    'Numbers ஒரு நேரத்தில் ஒரு தாளில் மட்டுமே தேடும். இங்கே ⌘F ஒவ்வொரு அட்டவணையையும் graph-ஐயும் உள்ளடக்கும்.',
  'tour.step5.action': 'Find-ஐத் திறந்து எதையாவது தட்டச்சு செய்யவும்',

  'tour.step6.title': 'மின்னஞ்சல் மூலம் ஒருவரை அழைக்கவும்',
  'tour.step6.body':
    'நீங்கள் அழைப்பவர்கள் ஒரு workscape-ஐ முதன்முறையாகத் திறக்கும்போது இதே வழிகாட்டியைப் பெறுவார்கள்.',
  'tour.step6.note':
    'iCloud பகிர்வைப் போலவே, ஒவ்வொரு நபருக்கும் நீங்கள் அமைக்கும் ஒரு அனுமதியுடன்.',
  'tour.step6.action': 'Share-ஐத் திறந்து ஒரு மின்னஞ்சலை அழைக்கவும்',

  'tour.done.message':
    'ஆறும் முடிந்தது. உங்கள் நூலகத்தில் உள்ள ? இலிருந்து எப்போது வேண்டுமானாலும் மீண்டும் இயக்கலாம்.',
  'tour.done.replay': 'மீண்டும் இயக்கு',

  'object.name.ring': '{table}-இன் வளையம்',
  'object.name.coverage': '{table}-இன் கவரேஜ்',
  'object.name.pair': '{table}-இன் வரைபடம்',
  'object.name.ringUnbound': 'வளையம்',
  'object.name.coverageUnbound': 'கவரேஜ்',
  'object.name.pairUnbound': 'வரைபடம்',
  'object.name.tableGraph': '{table} மற்றும் அதன் வரைபடம்',
  'object.name.tableGraphs': '{table} மற்றும் அதன் {count} வரைபடங்கள்',
  'object.deleted': '{name} நீக்கப்பட்டது — செயல்தவிர்க்க {undo} அழுத்தவும்',
  'object.deleted.ref':
    '{name} நீக்கப்பட்டது — வேறு இடத்தில் 1 கலம் இப்போது “குறிப்பு நீக்கப்பட்டது” எனக் காட்டுகிறது; செயல்தவிர்க்க {undo} அழுத்தவும்',
  'object.deleted.refs':
    '{name} நீக்கப்பட்டது — வேறு இடத்தில் {count} கலங்கள் இப்போது “குறிப்பு நீக்கப்பட்டது” எனக் காட்டுகின்றன; செயல்தவிர்க்க {undo} அழுத்தவும்',
  'object.collapsed': '{name} சுருக்கப்பட்டது',
  'object.expanded': '{name} விரிக்கப்பட்டது',
  'object.collapse': '{name} சுருக்கு',
  'object.expand': '{name} விரி',

  'sheet.name.tables': '{tables} கொண்ட {sheet}',
  'sheet.name.graphs': '{graphs} கொண்ட {sheet}',
  'sheet.name.both': '{tables} மற்றும் {graphs} கொண்ட {sheet}',
  'sheet.count.table': '1 அட்டவணை',
  'sheet.count.tables': '{count} அட்டவணைகள்',
  'sheet.count.graph': '1 வரைபடம்',
  'sheet.count.graphs': '{count} வரைபடங்கள்',
  'sheet.deleted': '{name} நீக்கப்பட்டது',
  'sheet.nowOn': '{deleted}. இப்போது {sheet}-இல்',
  'sheet.removedRemotely': '{sheet} நீக்கப்பட்டது — இப்போது {nowOn}-இல்',
  'sheet.renamed': '{from} என்பது {to} எனப் பெயர் மாற்றப்பட்டது',
  'sheet.restored': '{sheet} மீட்டெடுக்கப்பட்டது',
  'sheet.lastKept': 'ஒரு workscape குறைந்தது ஒரு தாளை வைத்திருக்கும்',
  'sheet.needsName': 'ஒரு தாளுக்கு ஒரு பெயர் தேவை',

  'library.help.label': 'உதவி',
  'library.help.replay': 'வழிகாட்டிச் சுற்றை மீண்டும் இயக்கு',
  'library.help.shortcuts': 'விசைப்பலகைக் குறுக்குவழிகள்',

  'auth.code.label.six': 'ஆறு இலக்கக் குறியீடு',
  'auth.code.label.eight': 'எட்டு இலக்கக் குறியீடு',
  'auth.code.sent.six': 'உங்கள் மின்னஞ்சலுக்கு ஆறு இலக்கக் குறியீட்டை அனுப்பியுள்ளோம்',
  'auth.code.sent.eight': 'உங்கள் மின்னஞ்சலுக்கு எட்டு இலக்கக் குறியீட்டை அனுப்பியுள்ளோம்',
  'auth.code.expires.signIn': 'குறியீடுகள் 10 நிமிடங்களில் காலாவதியாகும்',
  'auth.code.expires.signUp': 'குறியீடுகள் 24 மணி நேரத்தில் காலாவதியாகும்',

  'forms.power.hint': 'a-இன் ஒவ்வொரு உட்கணமும்',

  'set.lost': '{sets}-இல் இனி இல்லை',
  'set.readOnly.computed': 'இந்த நெடுவரிசை கணக்கிடப்படுகிறது',
  'set.rowComputed': 'இந்த வரிசை கணக்கிடப்படுகிறது',
  'cell.readOnly': 'படிக்க மட்டும்: {reason}',
  'cell.readOnly.announce': '{cell} படிக்க மட்டும்: {reason}',
  'cell.readOnly.announceUnaddressed': 'இந்தக் கலம் படிக்க மட்டும்: {reason}',
  'column.readOnly.announce': 'நெடுவரிசை {column} படிக்க மட்டும்: {reason}',
  'set.fillRefused': 'நெடுவரிசை {column} நிரப்பப்படவில்லை: நெடுவரிசை காலியாக இல்லை',
  'set.fillSuperseded':
    'நெடுவரிசை {column} நிரப்பப்படவில்லை: அட்டவணை வேறொரு சூத்திரத்தைப் பின்பற்றுகிறது',
  'readOnly.derived': 'வருவிக்கப்பட்ட நெடுவரிசை',
  'readOnly.linked': 'இணைக்கப்பட்ட நெடுவரிசை',
  'readOnly.pulled': 'வேறு அட்டவணையிலிருந்து இழுக்கப்பட்டது',
  'readOnly.group': 'வகைப் பட்டை',
  'readOnly.splitChild': 'பிரிக்கப்பட்ட துணை வரிசை',

  'addTable.title': 'இது எந்த வகை அட்டவணை?',
  'addTable.kinds': 'அட்டவணை வகை',
  'addTable.kind.plain': 'சாதாரண அட்டவணை',
  'addTable.kind.plain.hint': 'ஒரு சாதாரண GeDe அட்டவணை. கண விதிகள் இல்லை, சுருக்கப் பதிவு இல்லை.',
  'addTable.kind.simple': 'எளிய கணம்',
  'addTable.kind.simple.hint':
    'மிக அடிப்படையான கணம்: உறுப்புகளின் வரம்பு, ஒவ்வொன்றுக்கும் ஒரு குறிப்பு.',
  'addTable.kind.family': 'கணங்களின் குடும்பம்',
  'addTable.kind.family.hint':
    'கணங்களுக்குள் கணங்கள். ஒரு வரிசை ஓர் உறுப்பையோ, எளிய கணத்தையோ, மற்றொரு குடும்பத்தையோ கொண்டிருக்கும்.',
  'addTable.kind.computed': 'சூத்திரத்தால் கணக்கிடப்பட்டது',
  'addTable.kind.computed.hint':
    'இந்தத் தாளில் ஏற்கெனவே உள்ள கணங்களின் ஒன்றிப்பு, வெட்டு அல்லது வேறுபாடு. அவற்றோடு ஒத்து மாறும்.',
  'addTable.kind.product': 'கார்ட்டீசியன் பெருக்கம்',
  'addTable.kind.product.hint':
    'இரண்டு அல்லது அதற்கு மேற்பட்ட கணங்களிலிருந்து ஒவ்வொரு வரிசைப்பட்ட இணையும். வரிசைகள் |A| × |B| × …',
  'addTable.add': 'அட்டவணையைச் சேர்',
  'addTable.pickSets': 'கணங்களைத் தேர்ந்தெடு',
  'addTable.cancel': 'ரத்துசெய்',
  'addTable.back': 'பின்செல்',
  'addTable.added': '{table} சேர்க்கப்பட்டது',
  'pick.title': 'கணக்கிடப்பட்ட அட்டவணையைச் சேர்',
  'pick.description':
    'இந்தத் தாளில் ஏற்கெனவே உள்ள கணங்களிலிருந்து. அவை மாறும்போது முடிவு மீண்டும் கணக்கிடப்படும்.',
  'pick.operation': 'செயல்பாடு',
  'pick.op.Union': 'ஏதேனும் ஒரு கணத்தில் உள்ள உறுப்புகள்',
  'pick.op.Inter': 'ஒவ்வொரு கணத்திலும் உள்ள உறுப்புகள்',
  'pick.op.Diff': 'b-இல் இல்லாத a-இன் உறுப்புகள்',
  'pick.op.Cross': 'ஒவ்வொரு வரிசைப்பட்ட இணையும் (a, b, …)',
  'pick.sets': 'கணங்கள், வரிசைப்படி',
  'pick.firstSet': 'முதல் கணம்',
  'pick.secondSet': 'இரண்டாம் கணம்',
  'pick.set': 'கணம்',
  'pick.factor': 'பெருக்கத்தின் கணம் {n}',
  'pick.removeFactor': 'கணம் {n}-ஐ நீக்கு',
  'pick.addFactor': 'இன்னொரு கணத்தைச் சேர்',
  'pick.order':
    'வரிசை முக்கியம்: ஒவ்வொரு வரிசையும் ஒரு வரிசைப்பட்ட இணை. E × E போல ஒரு கணம் இருமுறை வரலாம்.',
  'pick.shape': 'ஒவ்வொரு இணையும் எங்கே',
  'pick.shape.column': 'ஒரு நெடுவரிசை',
  'pick.shape.column.hint':
    'ஒவ்வொரு கலமும் ஓர் இணையைக் கொண்டிருக்கும், (a, b, x). பெரிய அட்டவணையின் ஒரு நெடுவரிசையாக இதைப் பயன்படுத்துங்கள்.',
  'pick.shape.spread': 'ஒவ்வொரு கணத்துக்கும் ஒரு நெடுவரிசை',
  'pick.shape.spread.hint':
    'x1, x2, x3 வரிசையின் அடுத்தடுத்த கலங்களில் இருக்கும். அவற்றின் அருகே உங்கள் நெடுவரிசைகளைச் சேர்க்கலாம்.',
  'pick.formula': 'சூத்திரம்',
  'pick.noSets': 'இந்தத் தாளில் இன்னும் கணங்கள் இல்லை. முதலில் ஓர் எளிய கணத்தைச் சேர்க்கவும்.',
  'fill.menu': 'சூத்திரத்தால் நெடுவரிசையை நிரப்பு…',
  'fill.title': '{column}-ஐ ஒரு சூத்திரத்தால் நிரப்பு',
  'fill.description':
    'முடிவின் ஒவ்வொரு உறுப்புக்கும் ஒரு வரிசையை நெடுவரிசை நிரப்பும்; அதன் கணங்கள் மாறும்போது மீண்டும் கணக்கிடப்படும்.',
  'fill.confirm': 'நெடுவரிசையை நிரப்பு',
  'fill.notEmpty': 'நெடுவரிசை காலியாக இல்லை',
  'fill.filled': '{column} {formula} கொண்டு நிரப்பப்பட்டது',
  'fill.hasFormula': 'அட்டவணையில் ஏற்கெனவே ஒரு சூத்திரம் உள்ளது',
  'fill.derived': 'இந்த நெடுவரிசை வருவிக்கப்பட்டது',
  'fill.pulled': 'இந்த நெடுவரிசை வேறு அட்டவணையிலிருந்து இழுக்கப்பட்டது',
  'fill.linked': 'இந்த நெடுவரிசை ஓர் இணைப்பு நெடுவரிசை',
  'kind.typed': 'அட்டவணையில் தட்டச்சு செய்த மதிப்புகள் உள்ளன',
  'kind.needsFormula': 'முதலில் ஒரு நெடுவரிசையைச் சூத்திரத்தால் நிரப்புங்கள்',
  'kind.changed': '{table} இப்போது {kind}',
  'kind.needsCross': 'சூத்திரம் Cross அல்ல',
  'kind.isCross': 'சூத்திரம் ஒரு Cross',
  'kind.computedColumns': 'அதன் நெடுவரிசைகள் சூத்திரத்திலிருந்து நிரப்பப்படுகின்றன',
  'kind.section': 'வகை',
  'kind.section.hint': 'எந்தக் கலத்திலும் தட்டச்சு செய்த மதிப்பு இல்லாதபோது மாறும்.',
  'set.column.range': 'வரம்பு',
  'set.column.description': 'விளக்கம்',
  'set.column.note': 'குறிப்பு',
  'set.meta.label': 'கணத் தகவல்கள்',
  'set.meta.id': 'கண அடையாளம்',
  'set.meta.finiteness': 'முடிவுள்ளது அல்லது முடிவற்றது',
  'set.meta.variable': 'கட்டுண்ட அல்லது கட்டற்ற மாறி',
  'set.meta.quantifier': 'அளவுகாட்டி',
  'set.meta.status': 'சிறப்பு நிலை',
  'set.meta.undetermined': 'வரையறையிலிருந்து தீர்மானிக்க இயலவில்லை',
  'set.meta.none': 'இல்லை',
  'set.meta.finite': 'முடிவுள்ளது',
  'set.meta.bound': 'கட்டுண்டது',
  'set.meta.universal': 'அனைத்துக்குமான ∀',
  'set.meta.existential': 'இருப்புக்குரிய ∃',
  'set.meta.null': 'வெற்றுக் கணம்',
  'set.meta.singleton': 'ஓருறுப்புக் கணம்',
  'set.title.definition': 'வரையறை',
  'set.count.cardinality': '|{set}| = {count}',
  'set.count.bag': 'பை {count}',
  'set.count.label': '{set}: தனித்த உறுப்புகள் {cardinality}, பை {bag}',
  'set.repeat': '{degree}-இன் மறுநிகழ்வு',
  'set.split.offer': '{cell}-இல் {count} உறுப்புகள் உள்ளன',
  'set.split.action': 'வரிசைகளாகப் பிரி',
  'set.split.alt': '{cell}-ஐ உறுப்புக்கு ஒரு வரிசையாகப் பிரி',
  'set.split.done': '{cell} {count} வரிசைகளாகப் பிரிக்கப்பட்டது',
  'set.rowKind.element': 'உறுப்பு',
  'set.rowKind.set': 'கணம்',
  'set.rowKind.family': 'குடும்பம்',
  'set.split.single': 'இந்தக் கலத்தில் ஒரே உறுப்பு உள்ளது',
  'set.kind.header': 'வகை',
  'set.kind.label': 'வகை: {kind}',
  'set.definition.field': 'வரையறை',
  'set.definition.placeholder': '{ x | x ஓர் எழுத்து }',
  'set.definition.hint':
    'தலைப்பு வரிசையில் தட்டச்சு செய்தபடியே காட்டப்படும். கணம்-அமைப்புக் குறியீடு, ∀, ∃ ஆகியவை மெட்டா வரிசையை நிரப்புகின்றன.',
  'set.id.field': 'கண அடையாளம்',
  'set.meta.universalShort': '∀',
  'set.meta.existentialShort': '∃',
  'footer.rowsFiltered': '{total} இல் {shown} வரிசைகள்',
};
