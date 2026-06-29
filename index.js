const express = require('express');
const cors = require('cors');
const { Connection, PublicKey, clusterApiUrl } = require('@solana/web3.js');
const { Metaplex } = require('@metaplex-foundation/js');

const app = express();
// المنصات السحابية تضع المنفذ تلقائياً في متغير PORT
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// الاتصال بشبكة Devnet
const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');
const metaplex = Metaplex.make(connection);

// المسار الرئيسي للتأكد من عمل السيرفر
app.get('/', (req, res) => {
    res.json({ message: "Solana Metaplex API is running successfully!" });
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

        // جلب البيانات من البلوكتشين والملف الخارجي
        const tokenData = await metaplex.nfts().findByMint({ mintAddress: mintPubkey });

        res.json({
            success: true,
            data: {
                name: tokenData.name,
                ticker: tokenData.symbol,
                description: tokenData.json?.description || 'لا يوجد وصف متاح',
                image: tokenData.json?.image || 'لا توجد صورة متاحة'
            }
        });

    } catch (error) {
        console.error(error);
        if (error.message.includes('was not found')) {
            return res.status(404).json({ success: false, error: 'لم يتم العثور على بيانات Metaplex على شبكة Devnet.' });
        }
        res.status(500).json({ success: false, error: 'حدث خطأ في السيرفر.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
