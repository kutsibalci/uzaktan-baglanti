// test/ozellik-sertifika.js kullanır: dotnet run test/sertifika-zincir.cs -- <ca.cer> <sunucu.cer> [<sunucu2.cer> ...]
// .NET X509Chain, CA'yı YALNIZCA bu zincir için güvenilen kök yapar (CustomTrustStore + CustomRootTrust):
// kullanıcının sertifika deposuna hiçbir şey yazılmaz. Windows'ta CryptoAPI'nin gerçek doğrulaması çalışır (Name Constraints dahil).
// Her sertifika için bir satır: <geçti>|<zincir uzunluğu>|<kökün SHA-1'i>|<durumlar>
using System;
using System.Linq;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

var ca = X509CertificateLoader.LoadCertificateFromFile(args[0]);
for (int i = 1; i < args.Length; i++)
{
    var sunucu = X509CertificateLoader.LoadCertificateFromFile(args[i]);
    using var zincir = new X509Chain();
    zincir.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
    zincir.ChainPolicy.CustomTrustStore.Add(ca);
    zincir.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
    zincir.ChainPolicy.ApplicationPolicy.Add(new Oid("1.3.6.1.5.5.7.3.1")); // serverAuth
    var gecti = zincir.Build(sunucu);
    var durumlar = string.Join(",", zincir.ChainStatus.Select(s => s.Status.ToString()));
    var kok = zincir.ChainElements[zincir.ChainElements.Count - 1].Certificate.Thumbprint;
    Console.WriteLine($"{gecti}|{zincir.ChainElements.Count}|{kok}|{durumlar}");
}
