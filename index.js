const express = require('express');
const cors = require('cors');
const { Connection, PublicKey, clusterApiUrl } = require('@solana/web3.js');
const { Metaplex } = require('@metaplex-foundation/js');
const { getTokenMetadata } = require('@solana/spl-token'); // تم إضافة مكتبة Token-2022

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// الاتصال بشبكة Devnet
const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');
const metaplex = Metaplex.make(connection);

// المسار الرئيسي للتأكد من عمل السيرفر
app.get('/', (req, res) => {
    res.json({ message: "Solana Unified API (Metaplex & Token-2022) is running successfully!" });
});
// أضف هذا التعريف خارج المسار لاستخدامه في جلب عنوان Metaplex
const METAPLEX_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

app.get('/api/token/:mintAddress', async (req, res) => {
    try {
        const { mintAddress } = req.params;
        let mintPubkey;
        
        try {
            mintPubkey = new PublicKey(mintAddress);
        } catch (err) {
            return res.status(400).json({ success: false, error: 'عنوان العقد غير صالح.' });
        }

        let tokenDataResult = {
            name: '',
            ticker: '',
            description: 'لا يوجد وصف متاح',
            image: 'لا توجد صورة متاحة'
        };
        
        let isFound = false;

        // ---------------------------------------------------------
        // 1. تحديد البرنامج المالك للعقد (Token أو Token-2022)
        // ---------------------------------------------------------
        const accountInfo = await connection.getAccountInfo(mintPubkey);
        if (!accountInfo) {
            return res.status(404).json({ success: false, error: 'العملة غير موجودة على الشبكة.' });
        }
        const programId = accountInfo.owner; 

        // ---------------------------------------------------------
        // 2. المحاولة الأولى: جلب البيانات المدمجة (لعملات Token-2022 فقط)
        // ---------------------------------------------------------
        if (programId.toBase58() === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') {
            try {
                // من الضروري تمرير programId للدالة لتعمل بشكل صحيح مع 2022
                const token2022Metadata = await getTokenMetadata(connection, mintPubkey, 'confirmed', programId);
                
                if (token2022Metadata) {
                    tokenDataResult.name = token2022Metadata.name;
                    tokenDataResult.ticker = token2022Metadata.symbol;
                    
                    if (token2022Metadata.uri) {
                        try {
                            const response = await fetch(token2022Metadata.uri);
                            const jsonMeta = await response.json();
                            tokenDataResult.description = jsonMeta.description || tokenDataResult.description;
                            tokenDataResult.image = jsonMeta.image || tokenDataResult.image;
                        } catch (fetchErr) {
                            console.error('فشل في جلب الرابط الخارجي (URI) لـ Token-2022');
                        }
                    }
                    isFound = true;
                }
            } catch (err) {
                // نتجاهل الخطأ وننتقل للبحث في Metaplex
                console.log("لم يتم العثور على بيانات مدمجة، جاري التحقق من Metaplex...");
            }
        }

        // ---------------------------------------------------------
        // 3. المحاولة الثانية: جلب البيانات عبر Metaplex PDA 
        // (تعمل لكل من التوكن العادي و 2022 التي تستخدم MetadataPointer)
        // ---------------------------------------------------------
        if (!isFound) {
            try {
                // اشتقاق عنوان الحساب الخاص بالـ Metadata يدوياً لتجاوز أخطاء `findByMint`
                const [metadataPDA] = PublicKey.findProgramAddressSync(
                    [
                        Buffer.from('metadata'),
                        METAPLEX_PROGRAM_ID.toBuffer(),
                        mintPubkey.toBuffer()
                    ],
                    METAPLEX_PROGRAM_ID
                );

                // جلب البيانات الوصفية باستخدام الـ PDA بدلاً من عنوان العقد
                const tokenData = await metaplex.nfts().findByMetadata({ metadata: metadataPDA });
                
                tokenDataResult.name = tokenData.name;
                tokenDataResult.ticker = tokenData.symbol;
                tokenDataResult.description = tokenData.json?.description || tokenDataResult.description;
                tokenDataResult.image = tokenData.json?.image || tokenDataResult.image;
                
                isFound = true;
            } catch (err) {
                // لم يتم العثور على بيانات في Metaplex
            }
        }

        // ---------------------------------------------------------
        // 4. التحقق النهائي وإرسال النتيجة
        // ---------------------------------------------------------
        if (!isFound) {
            return res.status(404).json({ 
                success: false, 
                error: 'لم يتم العثور على بيانات العملة (لا كـ Token-2022 ولا كـ Metaplex).' 
            });
        }

        res.json({
            success: true,
            data: tokenDataResult
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 'حدث خطأ داخلي في الخادم.' });
    }
});
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
