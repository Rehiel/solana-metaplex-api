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

// مسار جلب البيانات
app.get('/api/token/:mintAddress', async (req, res) => {
    try {
        const { mintAddress } = req.params;
        let mintPubkey;
        
        try {
            mintPubkey = new PublicKey(mintAddress);
        } catch (err) {
            return res.status(400).json({ success: false, error: 'عنوان العقد غير صالح.' });
        }

        // هيكل مبدئي للبيانات لتخزين النتيجة النهائية
        let tokenDataResult = {
            name: '',
            ticker: '',
            description: 'لا يوجد وصف متاح',
            image: 'لا توجد صورة متاحة'
        };
        
        let isFound = false;

        // ---------------------------------------------------------
        // 1. المحاولة الأولى: فحص إذا كانت العملة Token-2022
        // ---------------------------------------------------------
        try {
            const token2022Metadata = await getTokenMetadata(connection, mintPubkey);
            
            if (token2022Metadata) {
                tokenDataResult.name = token2022Metadata.name;
                tokenDataResult.ticker = token2022Metadata.symbol;
                
                // التوكنات 2022 تخزن رابط JSON في خانة "uri"
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
            // سيحدث خطأ هنا طبيعياً إذا لم تكن العملة Token-2022، لذا سنتجاهله للمحاولة الثانية
        }

        // ---------------------------------------------------------
        // 2. المحاولة الثانية: استخدام Metaplex (للتوكنات العادية)
        // ---------------------------------------------------------
        if (!isFound) {
            try {
                const tokenData = await metaplex.nfts().findByMint({ mintAddress: mintPubkey });
                
                tokenDataResult.name = tokenData.name;
                tokenDataResult.ticker = tokenData.symbol;
                tokenDataResult.description = tokenData.json?.description || tokenDataResult.description;
                tokenDataResult.image = tokenData.json?.image || tokenDataResult.image;
                
                isFound = true;
            } catch (err) {
                // سيحدث خطأ إذا لم يتم العثور على العملة في نظام Metaplex
            }
        }

        // ---------------------------------------------------------
        // 3. التحقق النهائي وإرسال النتيجة
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
