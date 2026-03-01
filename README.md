# 🎬 Disney+ Subtitle Downloader

Disney+ platformundan altyazı indirmek için geliştirilmiş Tampermonkey userscript'i. Tek bölüm, tüm diller veya tüm sezon altyazılarını ZIP olarak indirebilirsiniz.

## ✨ Özellikler

### 📥 Altyazı İndirme
- **Tek bölüm altyazı** — İzlediğiniz bölümün istediğiniz dildeki altyazısını anında indirin
- **Tüm diller ZIP** — Mevcut tüm dillerin altyazılarını tek ZIP dosyasında indirin
- **Sezon indirme** — Tüm sezonun altyazılarını seçtiğiniz dilde toplu olarak indirin
- **Forced altyazı desteği** — Zorlanmış (forced) altyazılar ayrı olarak listelenir ve indirilebilir

### 🔄 Format Desteği
- **VTT → SRT dönüştürme** — Disney+'ın VTT formatındaki altyazıları otomatik olarak SRT'ye dönüştürür
- **VTT formatı** — Orijinal WebVTT formatında indirme seçeneği
- **Segment birleştirme** — Parçalı M3U8 altyazı segmentleri otomatik birleştirilir

### 📦 Akıllı İndirme Motoru
- **Rate limiting** — Disney+ API limitlerini aşmamak için otomatik hız kontrolü
- **Backoff mekanizması** — 429 (rate limit) hatalarında otomatik bekleme ve yeniden deneme
- **Token yönetimi** — Auth token süresi dolduğunda uyarı verir
- **Service Worker header çıkarımı** — Disney+ Service Worker'dan gerekli API header'larını otomatik alır
- **Otomatik bölüm keşfi** — Disney+ sayfaları bölümleri 15'erli gruplar halinde lazy-load eder. Script, tüm bölümlerin yüklenmesi için sayfayı otomatik kaydırır ve geri döner
- **Sayfalama (pagination)** — Sezon indirirken API üzerinden tüm bölümler otomatik çekilir (sayfa başına 30, max 10 sayfa)

### 🖥️ Kullanıcı Arayüzü
- **Dark tema** — Disney+ arayüzüne uyumlu koyu tema
- **/browse sayfası** — Sadece sezon indirme paneli görünür
- **/play sayfası** — Bölüm altyazıları + sezon indirme birlikte görünür
- **Üst progress bar** — İndirme durumu ekranın üstünde ince mavi çizgiyle gösterilir
- **Buton üzerinde progress** — Panel kapalıyken bile indirme durumu ana butonda görünür (`İndiriliyor 3/8`)

### 📝 Dosya İsimlendirme
Dosyalar temiz ve düzenli şekilde isimlendirilir:
```
Dizi.Adi.S01E01.Bolum.Adi.Turkish.srt
Dizi.Adi.S02E05.Bolum.Adi.English.srt
```

ZIP dosyaları düz yapıdadır (klasör içermez).

## 📋 Gereksinimler

- Modern bir tarayıcı (Chrome, Firefox, Edge)
- Aşağıdaki userscript eklentilerinden biri:
  - [Tampermonkey](https://www.tampermonkey.net/) (Önerilen)
  - [Violentmonkey](https://violentmonkey.github.io/)
  - [Greasemonkey](https://www.greasespot.net/)

## 🚀 Kurulum

1. Yukarıdaki eklentilerden birini tarayıcınıza kurun
2. **[Script'i Yükle](https://raw.githubusercontent.com/victories/disney-subtitle-downloader/main/disney-plus-subtitle-downloader.user.js)** bağlantısına tıklayın
3. Açılan eklenti sayfasında **Yükle / Install** butonuna tıklayın
4. Disney+ açın — sağ üst köşede **Altyazı** butonu görünecektir

## 📖 Kullanım

### Tek Bölüm İndirme
1. Disney+'ta bir bölüm oynatın
2. Sağ üstteki **Altyazı** butonuna tıklayın
3. İstediğiniz dilin yanındaki **SRT** butonuna tıklayın

### Tüm Dilleri İndirme
1. Bir bölüm oynatırken paneli açın
2. **Tümünü ZIP İndir** butonuna tıklayın

### Sezon İndirme
1. Bir dizinin sayfasına gidin (`/browse`) veya bir bölüm oynatın (`/play`)
2. Paneldeki **Sezon İndirme** bölümünden:
   - Sezon seçin
   - Dil seçin
   - **Tüm Sezonu İndir** butonuna tıklayın
3. İndirme durumu buton üzerinde ve üst progress bar'da gösterilir

### Format Değiştirme
- Paneldeki **Format** seçicisinden SRT veya VTT seçebilirsiniz

## ⚙️ Teknik Detaylar

### Nasıl Çalışır
1. **Intercept** — Disney+'ın playback API isteklerini yakalar (XHR/Fetch)
2. **Bölüm Keşfi** — Sayfa açılınca bölüm listesi yakalanır. 15+ bölümlü dizilerde sayfa otomatik kaydırılarak kalan bölümler de yüklenir
3. **M3U8 Parse** — HLS manifest'inden altyazı track'lerini çıkarır
4. **VTT Segmentleri** — Parçalı altyazı dosyalarını indirir ve birleştirir
5. **Dönüştürme** — VTT formatını SRT'ye dönüştürür (zaman damgaları, etiketler)
6. **Paketleme** — JSZip ile ZIP dosyası oluşturur, FileSaver ile indirir

### Teknoloji
- Vanilla JavaScript (framework yok)
- [JSZip](https://stuk.github.io/jszip/) — ZIP oluşturma
- [FileSaver.js](https://github.com/nicolo-ribaudo/FileSaver.js) — Dosya indirme
- Disney+ Playback API v7
- HLS M3U8 + WebVTT parser

### Veri Saklama

| Anahtar | Açıklama |
|---------|----------|
| `dplus_sd_{id}_auth` | Auth token |
| `dplus_sd_{id}_body` | Playback API body template |
| `dplus_sd_{id}_headers` | API x-* header'ları |
| `dplus_sd_{id}_media_id` | Yakalanan media ID |

Veriler content-scoped localStorage'da tutulur. Her dizi/film kendi scope'unda saklanır, çoklu sekme desteği vardır.

## 🔧 Sorun Giderme

| Sorun | Çözüm |
|-------|-------|
| Altyazı butonu görünmüyor | Sayfayı yenileyin, bir bölüm oynatın |
| Sezon indirme çalışmıyor | Önce bir bölümü oynatarak token alın |
| Token süresi doldu uyarısı | Herhangi bir bölümü birkaç saniye oynatın |
| 429 hatası (rate limit) | Script otomatik bekler, müdahale etmeyin |
| 15+ bölümlü dizide tüm bölümler görünmüyor | Sayfa açıldığında script otomatik kaydırma yapar. Birkaç saniye bekleyin |

## 📄 Lisans

Bu proje [MIT Lisansı](LICENSE) ile lisanslanmıştır.

## 🤝 Katkıda Bulunma

1. Bu repo'yu fork edin
2. Yeni bir branch oluşturun (`git checkout -b feature/yeni-ozellik`)
3. Değişikliklerinizi commit edin (`git commit -m 'Yeni özellik eklendi'`)
4. Branch'inizi push edin (`git push origin feature/yeni-ozellik`)
5. Pull Request açın
