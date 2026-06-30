const express = require('express');
const cors = require('cors');
const { 
    Connection, 
    PublicKey, 
    clusterApiUrl, 
    VersionedTransaction, 
    TransactionMessage, 
    SystemProgram 
} = require('@solana/web3.js');
const { Metaplex } = require('@metaplex-foundation/js');
const { 
    getTokenMetadata, 
    getAssociatedTokenAddressSync, 
    createAssociatedTokenAccountInstruction, 
    createTransferCheckedWithTransferHookInstruction, // الدالة المخصصة للـ Hooks
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID
} = require('@solana/spl-token');

const app = express();
const PORT = process.env.PORT || 3000;

// إعداد CORS للسماح بالطلبات من أي مصدر (بما فيها المتصفح أثناء التطوير)
const corsOptions = {
  origin: '*', 
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions)); 
app.use(express.json()); 

// الاتصال بشبكة Devnet (يمكنك تغييرها إلى mainnet-beta لاحقاً)
const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');
const metaplex = Metaplex.make(connection);
const METAPLEX_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

// ==========================================
// 1. مسار جلب البيانات الوصفية للعملة
// ==========================================
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
            image: null
        };
        
        let isFound = false;

        const accountInfo = await connection.getAccountInfo(mintPubkey);
        if (!accountInfo) {
            return res.status(404).json({ success: false, error: 'العملة غير موجودة على الشبكة.' });
        }
        const programId = accountInfo.owner; 

        // محاولة جلب البيانات إذا كانت Token-2022
        if (programId.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58()) {
            try {
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
                            console.error('فشل في جلب الرابط الخارجي لـ Token-2022');
                        }
                    }
                    isFound = true;
                }
            } catch (err) {
                console.log("لم يتم العثور على بيانات مدمجة، جاري الانتقال إلى Metaplex...");
            }
        }

        // محاولة جلب البيانات من Metaplex إذا كانت من المعيار القديم
        if (!isFound) {
            try {
                const [metadataPDA] = PublicKey.findProgramAddressSync(
                    [Buffer.from('metadata'), METAPLEX_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
                    METAPLEX_PROGRAM_ID
                );
                const tokenData = await metaplex.nfts().findByMetadata({ metadata: metadataPDA });
                
                tokenDataResult.name = tokenData.name;
                tokenDataResult.ticker = tokenData.symbol;
                tokenDataResult.description = tokenData.json?.description || tokenDataResult.description;
                tokenDataResult.image = tokenData.json?.image || tokenDataResult.image;
                
                isFound = true;
            } catch (err) {
                console.log("تعذر العثور على البيانات في Metaplex");
            }
        }

        if (!isFound) {
            return res.status(404).json({ success: false, error: 'لم يتم العثور على بيانات العملة.' });
        }

        res.json({ success: true, data: tokenDataResult });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 'حدث خطأ داخلي في الخادم.' });
    }
});

// ==========================================
// 2. إنشاء المعاملة غير الموقعة (مبنية ديناميكياً وتدعم الـ Hooks)
// ==========================================
app.post('/api/transaction/create', async (req, res) => {
    try {
        const { sender, transfers } = req.body;

        if (!sender || !Array.isArray(transfers) || transfers.length === 0) {
            return res.status(400).json({ success: false, error: 'بيانات المعاملة غير صحيحة أو مفقودة.' });
        }

        const senderPubkey = new PublicKey(sender);
        const instructions = [];

        const { blockhash } = await connection.getLatestBlockhash('confirmed');

        for (const transfer of transfers) {
            const { receiver, mint, amount, decimals } = transfer;
            
            if (!receiver || !mint || !amount) {
                throw new Error("بعض بيانات التحويل مفقودة في المصفوفة.");
            }

            const receiverPubkey = new PublicKey(receiver);

            // أ) تحويل SOL الأساسي
            if (mint === 'SOL') {
                const lamports = Math.round(parseFloat(amount) * 1e9);
                instructions.push(
                    SystemProgram.transfer({
                        fromPubkey: senderPubkey,
                        toPubkey: receiverPubkey,
                        lamports: lamports
                    })
                );
            } 
            // ب) تحويل توكن (يدعم Token-2022 والـ Transfer Hooks)
            else {
                const mintPubkey = new PublicKey(mint);
                const mintAccountInfo = await connection.getAccountInfo(mintPubkey);
                
                if (!mintAccountInfo) {
                    throw new Error(`عقد التوكن ${mint} غير موجود.`);
                }
                const tokenProgramId = mintAccountInfo.owner; // سيحدد تلقائياً هل هو 2022 أم المعيار القديم

                const senderATA = getAssociatedTokenAddressSync(mintPubkey, senderPubkey, false, tokenProgramId);
                const receiverATA = getAssociatedTokenAddressSync(mintPubkey, receiverPubkey, false, tokenProgramId);

                // التأكد من وجود حساب ATA للمستلم
                const receiverAtaInfo = await connection.getAccountInfo(receiverATA);
                if (!receiverAtaInfo) {
                    instructions.push(
                        createAssociatedTokenAccountInstruction(
                            senderPubkey,
                            receiverATA,
                            receiverPubkey,
                            mintPubkey,
                            tokenProgramId
                        )
                    );
                }

                const rawAmount = Math.round(parseFloat(amount) * Math.pow(10, parseInt(decimals || 0)));

                // استخدام الدالة الذكية التي تتخاطب مع العقد لمعرفة الحسابات الإضافية المطلوبة
                const transferInstruction = await createTransferCheckedWithTransferHookInstruction(
                    connection,
                    senderATA,
                    mintPubkey,
                    receiverATA,
                    senderPubkey,
                    rawAmount,
                    parseInt(decimals || 0),
                    [],
                    'confirmed',
                    tokenProgramId
                );

                instructions.push(transferInstruction);
            }
        }

        // تجميع كل التعليمات في معاملة واحدة من نوع Version0
        const messageV0 = new TransactionMessage({
            payerKey: senderPubkey,
            recentBlockhash: blockhash,
            instructions: instructions
        }).compileToV0Message();

        const transaction = new VersionedTransaction(messageV0);
        const serializedTx = Buffer.from(transaction.serialize()).toString('base64');

        res.json({ success: true, transaction: serializedTx });

    } catch (error) {
        console.error("فشل بناء المعاملة على السيرفر:", error);
        res.status(500).json({ success: false, error: error.message || 'حدث خطأ أثناء إعداد المعاملة.' });
    }
});

// ==========================================
// 3. مسار بث المعاملة الموقعة إلى الشبكة
// ==========================================
app.post('/api/transaction/broadcast', async (req, res) => {
    try {
        const { tx } = req.body;
        if (!tx) return res.status(400).json({ success: false, error: 'لا توجد بيانات معاملة موقّعة.' });

        const txBuffer = Buffer.from(tx, 'base64');
        const transaction = VersionedTransaction.deserialize(txBuffer);

        const txHash = await connection.sendTransaction(transaction, {
            skipPreflight: false, // من الأفضل تركه false لاكتشاف الأخطاء بدقة
            preflightCommitment: 'confirmed'
        });

        res.json({ success: true, result: txHash });
    } catch (error) {
        console.error("فشل بث المعاملة:", error);
        res.status(500).json({ success: false, error: error.message || 'فشل بث المعاملة للشبكة.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running dynamically on port ${PORT}`);
});
