/**
 * おもいで付箋ボード — 設定ファイル
 * GASを再デプロイしてURLが変わったら GAS_URL だけ書き換えてください。
 * （アプリの「設定」画面で入力した URL は、このファイルより優先されます）
 */
window.APP_CONFIG = {
  APP_NAME: 'おもいで付箋ボード',
  VERSION: '1.1.1',
  GAS_URL: 'https://script.google.com/macros/s/AKfycbzw5OeeBDuEbNiJPPCTYs6cfewKZdWUt334vDL1PP6_syo34C_PP1wgkiFgd6fS0lM7/exec',
  TTS_VOICE: 'Kore',            // Gemini TTS の声（設定画面で変更可）
  NARRATION_MIN_SEC: 6.5,       // 走馬灯で1枚を映す最短秒数
  FLIGHT_DISTANCE_KM: 30,       // 撮影地がこれ以上離れたら地図フライトを挟む
  UPLOAD_PARALLEL: 3,           // 写真を同時にアップロードする数
};
