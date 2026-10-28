#!/usr/bin/env bash
# Küçük ffmpeg: yalnızca uygulamanın ve testlerin kullandığı parçalarla, resmi kaynaklardan Windows için çapraz derleme
# (Ubuntu + mingw-w64; .github/workflows/ffmpeg.yml çalıştırır). ffmpeg-static'in 83 MB'lık her şeyi içeren sürümü yerine.
# İçindekiler:
#   giriş     gdigrab (ekran), lavfi (color/testsrc2/nullsrc: kodlayıcı denemesi ve testler), ddagrab (DXGI yakalama)
#   kodlayıcı h264_nvenc, h264_amf, h264_qsv, libx264 (işlemci), libopus (ses), png/rawvideo/pcm_s16le (testler)
#   çözücü    h264, mjpeg, png, opus, rawvideo, pcm_s16le (testler)
#   diğer     h264/ogg/null/rawvideo/s16le/image2/framecrc biçimleri, h264_metadata ve trace_headers süzgeçleri, d3d11/cuda
# Kullanım: tools/ffmpeg-derle.sh [ffmpeg etiketi]   → dist/ffmpeg/ffmpeg.exe, lisanslar/, yapilandirma.txt
set -euo pipefail

FFMPEG_SURUM="${1:-n8.1.2}"
ZLIB_SURUM=1.3.1
OPUS_SURUM=1.5.2
NVENC_BASLIK=n12.1.14.0   # NVIDIA sürücüsü 530 ve üstü
VPL_SURUM=v2.13.0
HOST=x86_64-w64-mingw32

KOK="$PWD/dist/ffmpeg-derleme"
ONEK="$KOK/onek"
CIKTI="$PWD/dist/ffmpeg"
rm -rf "$KOK" "$CIKTI"
mkdir -p "$KOK" "$ONEK/include" "$ONEK/lib/pkgconfig" "$CIKTI/lisanslar"
export PKG_CONFIG_LIBDIR="$ONEK/lib/pkgconfig"
export PKG_CONFIG_PATH="$ONEK/lib/pkgconfig"
IS=$(nproc)
cd "$KOK"

adim() { echo; echo "=== $* ==="; }

adim "zlib $ZLIB_SURUM"
curl -fsSL "https://github.com/madler/zlib/releases/download/v$ZLIB_SURUM/zlib-$ZLIB_SURUM.tar.gz" | tar xz
make -C "zlib-$ZLIB_SURUM" -f win32/Makefile.gcc PREFIX="$HOST-" -j"$IS"
make -C "zlib-$ZLIB_SURUM" -f win32/Makefile.gcc PREFIX="$HOST-" BINARY_PATH="$ONEK/bin" INCLUDE_PATH="$ONEK/include" LIBRARY_PATH="$ONEK/lib" install
cp "zlib-$ZLIB_SURUM/LICENSE" "$CIKTI/lisanslar/zlib.txt"

adim "x264 (stable)"
git clone --depth 1 --branch stable https://code.videolan.org/videolan/x264.git
(cd x264 && ./configure --host="$HOST" --cross-prefix="$HOST-" --prefix="$ONEK" --enable-static --disable-cli --disable-opencl \
  && make -j"$IS" && make install)
cp x264/COPYING "$CIKTI/lisanslar/x264.txt"
X264_SURUM=$(git -C x264 log -1 --format='%h %cs')

adim "opus $OPUS_SURUM"
curl -fsSL "https://downloads.xiph.org/releases/opus/opus-$OPUS_SURUM.tar.gz" | tar xz
# mingw'de _FORTIFY_SOURCE ve yığın koruyucusu libssp ister (statik bağlamada eksik): kapalı
(cd "opus-$OPUS_SURUM" && CFLAGS="-O2 -D_FORTIFY_SOURCE=0" ./configure --host="$HOST" --prefix="$ONEK" --enable-static --disable-shared \
  --disable-doc --disable-extra-programs --disable-stack-protector && make -j"$IS" && make install)
cp "opus-$OPUS_SURUM/COPYING" "$CIKTI/lisanslar/opus.txt"

adim "nv-codec-headers $NVENC_BASLIK"
git clone --depth 1 --branch "$NVENC_BASLIK" https://github.com/FFmpeg/nv-codec-headers.git
make -C nv-codec-headers PREFIX="$ONEK" install
head -n 30 nv-codec-headers/include/ffnvcodec/nvEncodeAPI.h > "$CIKTI/lisanslar/nv-codec-headers.txt"

adim "AMF başlıkları"
git clone --depth 1 --filter=blob:none --sparse https://github.com/GPUOpen-LibrariesAndSDKs/AMF.git amf
git -C amf sparse-checkout set amf/public/include
mkdir -p "$ONEK/include/AMF"
cp -r amf/amf/public/include/* "$ONEK/include/AMF/"
git -C amf sparse-checkout add LICENSE.txt 2>/dev/null || true
[ -f amf/LICENSE.txt ] && cp amf/LICENSE.txt "$CIKTI/lisanslar/amf.txt" || true
AMF_SURUM=$(git -C amf log -1 --format='%h %cs')

adim "libvpl $VPL_SURUM (Intel QSV)"
git clone --depth 1 --branch "$VPL_SURUM" https://github.com/intel/libvpl.git
cmake -S libvpl -B libvpl/b -DCMAKE_SYSTEM_NAME=Windows -DCMAKE_C_COMPILER="$HOST-gcc" -DCMAKE_CXX_COMPILER="$HOST-g++" \
  -DCMAKE_RC_COMPILER="$HOST-windres" -DCMAKE_FIND_ROOT_PATH="$ONEK" -DCMAKE_INSTALL_PREFIX="$ONEK" -DCMAKE_INSTALL_LIBDIR=lib \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTS=OFF -DBUILD_EXAMPLES=OFF -DINSTALL_EXAMPLES=OFF \
  -DBUILD_TOOLS=OFF -DBUILD_PREVIEW=OFF -DBUILD_EXPERIMENTAL=OFF
cmake --build libvpl/b -j"$IS"
cmake --install libvpl/b
cp libvpl/LICENSE "$CIKTI/lisanslar/libvpl.txt"
# Statik bağlamada C++ çalışma kitaplığı ve Windows kitaplıkları da gerekir
sed -i 's/^Libs.private:.*/& -lstdc++ -lole32 -luuid -lshlwapi -ladvapi32/' "$ONEK/lib/pkgconfig/vpl.pc" || true
grep -q '^Libs.private' "$ONEK/lib/pkgconfig/vpl.pc" || echo 'Libs.private: -lstdc++ -lole32 -luuid -lshlwapi -ladvapi32' >> "$ONEK/lib/pkgconfig/vpl.pc"

adim "FFmpeg $FFMPEG_SURUM"
git clone --depth 1 --branch "$FFMPEG_SURUM" https://github.com/FFmpeg/FFmpeg.git ffmpeg
YAPILANDIRMA=(
  --prefix="$ONEK" --arch=x86_64 --target-os=mingw32 --cross-prefix="$HOST-" --pkg-config=pkg-config --pkg-config-flags=--static
  --extra-cflags="-I$ONEK/include" --extra-ldflags="-L$ONEK/lib -static" --extra-libs="-lstdc++"
  --disable-shared --enable-static --disable-debug --disable-doc --disable-ffplay --disable-ffprobe --disable-network
  --disable-autodetect --disable-everything --enable-w32threads
  --enable-gpl --enable-zlib --enable-libx264 --enable-libopus
  --enable-ffnvcodec --enable-nvenc --enable-cuda --enable-amf --enable-libvpl --enable-d3d11va
  --enable-indev=gdigrab,lavfi
  --enable-filter=buffer,buffersink,abuffer,abuffersink,format,aformat,aresample,scale,null,anull,fps,crop,color,testsrc2,nullsrc,ddagrab,hwdownload,hwupload,hwmap
  --enable-encoder=h264_nvenc,h264_amf,h264_qsv,libx264,libopus,png,rawvideo,pcm_s16le,wrapped_avframe
  --enable-decoder=h264,mjpeg,png,opus,rawvideo,pcm_s16le
  --enable-parser=h264,mjpeg,png,opus
  --enable-demuxer=h264,image2,image_jpeg_pipe,image_png_pipe,ogg,pcm_s16le,rawvideo
  --enable-muxer=h264,null,ogg,rawvideo,pcm_s16le,image2,framecrc
  --enable-bsf=h264_metadata,trace_headers,h264_mp4toannexb,extract_extradata,null
  --enable-protocol=file,pipe
)
(cd ffmpeg && ./configure "${YAPILANDIRMA[@]}" || { tail -n 60 ffbuild/config.log; exit 1; })
make -C ffmpeg -j"$IS" ffmpeg.exe
"$HOST-strip" -o "$CIKTI/ffmpeg.exe" ffmpeg/ffmpeg.exe
cp ffmpeg/COPYING.GPLv2 "$CIKTI/lisanslar/ffmpeg-GPLv2.txt"
cp ffmpeg/LICENSE.md "$CIKTI/lisanslar/ffmpeg-LICENSE.md"

{
  echo "Küçük ffmpeg (Uzaktan Bağlantı) — tools/ffmpeg-derle.sh ile resmi kaynaklardan derlendi."
  echo "Lisans: GPL (libx264 nedeniyle). Kaynak: aşağıdaki sürümler + bu betik."
  echo
  echo "FFmpeg           $FFMPEG_SURUM  https://github.com/FFmpeg/FFmpeg"
  echo "x264             stable $X264_SURUM  https://code.videolan.org/videolan/x264"
  echo "opus             $OPUS_SURUM  https://downloads.xiph.org/releases/opus/"
  echo "zlib             $ZLIB_SURUM  https://github.com/madler/zlib"
  echo "nv-codec-headers $NVENC_BASLIK  https://github.com/FFmpeg/nv-codec-headers"
  echo "AMF başlıkları   $AMF_SURUM  https://github.com/GPUOpen-LibrariesAndSDKs/AMF"
  echo "libvpl           $VPL_SURUM  https://github.com/intel/libvpl"
  echo
  echo "configure ${YAPILANDIRMA[*]}"
} > "$CIKTI/yapilandirma.txt"
ls -la "$CIKTI"
echo "ffmpeg.exe boyutu: $(du -h "$CIKTI/ffmpeg.exe" | cut -f1)"
