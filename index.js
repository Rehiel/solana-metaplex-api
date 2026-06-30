const express = require('express');
const cors = require('cors'); // استيراد المكتبة
const app = express();

// إعداد CORS للسماح بالطلبات من أي مصدر
const corsOptions = {
  origin: '*', // يسمح لأي موقع بالاتصال (أو يمكنك وضع رابط موقعك المحدد هنا لمزيد من الأمان)
  methods: ['GET', 'POST', 'OPTIONS'], // تحديد الطرق المسموحة
  allowedHeaders: ['Content-Type', 'Authorization'], // تحديد الهيدرات المسموحة
  optionsSuccessStatus: 200 // لبعض المتصفحات القديمة
};

app.use(cors(corsOptions)); // تفعيل الـ Middleware
app.use(express.json()); // ضروري لقراءة بيانات JSON القادمة من الـ PHP أو الـ Frontend

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
    createTransferCheckedInstruction,
    TOKEN_PROGRAM_ID, 
    TOKEN_2022_PROGRAM_ID 
} = require('@solana/spl-token');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// الاتصال بشبكة Devnet
const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');
const metaplex = Metaplex.make(connection);

const METAPLEX_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

// عناوين افتراضية للعملات الخاصة بالمعاملات المركبة (استبدلها بعناوين عقودك الفعلية)
const RHL_MINT = new PublicKey("Hpt8Z2...YourRhlMintAddress..."); 
const VOLT_MINT = new PublicKey("VLT8zQ...YourVoltMintAddress...");
const VOLT_TREASURY = new PublicKey("Trs8xP...YourVoltTreasuryAddress..."); // الجهة التي تذهب إليها عملات VOLT المستهلكة

// 1. مسار جلب البيانات الوصفية للعملة
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

// 2. إنشاء المعاملة غير الموقعة (مبنية بالكامل على السيرفر)
app.post('/api/transaction/create', async (req, res) => {
    try {
        const { sender, receiver, mint, amount, decimals } = req.body;

        if (!sender || !receiver || !mint || !amount) {
            return res.status(400).json({ success: false, error: 'المعاملات المطلوبة غير مكتملة.' });
        }

        const senderPubkey = new PublicKey(sender);
        const receiverPubkey = new PublicKey(receiver);
        const instructions = [];

        // أخذ أحدث Blockhash من الشبكة
        const { blockhash } = await connection.getLatestBlockhash('confirmed');

        // أ) التحقق وإعداد تحويل العملة الأساسية SOL
        if (mint === 'SOL') {
            const lamports = Math.round(parseFloat(amount) * 1e9);
            instructions.push(
                SystemProgram.transfer({
                    fromPubkey: senderPubkey,
                    toPubkey: receiverPubkey,
                    lamports: lamports
                })
            );
        } else {
            // ب) إعداد تحويل توكن (SPL أو Token-2022)
            const mintPubkey = new PublicKey(mint);
            
            // تحديد البرنامج المالك لتوكن (معيار قديم أم 2022)
            const mintAccountInfo = await connection.getAccountInfo(mintPubkey);
            if (!mintAccountInfo) {
                return res.status(404).json({ success: false, error: 'عقد التوكن غير موجود.' });
            }
            const tokenProgramId = mintAccountInfo.owner;

            // اشتقاق حسابات الـ ATA للطرفين
            const senderATA = getAssociatedTokenAddressSync(mintPubkey, senderPubkey, false, tokenProgramId);
            const receiverATA = getAssociatedTokenAddressSync(mintPubkey, receiverPubkey, false, tokenProgramId);

            // التحقق تلقائياً من وجود حساب ATA للمستلم، وإنشائه إذا كان مفقوداً
            const receiverAtaInfo = await connection.getAccountInfo(receiverATA);
            if (!receiverAtaInfo) {
                instructions.push(
                    createAssociatedTokenAccountInstruction(
                        senderPubkey, // دافع رسوم إنشاء الحساب
                        receiverATA,
                        receiverPubkey,
                        mintPubkey,
                        tokenProgramId
                    )
                );
            }

            // حساب الكمية الدقيقة بناءً على الديسيمالز للتوكن
            const rawAmount = Math.round(parseFloat(amount) * Math.pow(10, parseInt(decimals || 0)));

            // إدراج تعليمة التحويل الآمنة المتوافقة مع الـ Transfer Fees وضريبة الـ Token-2022
            instructions.push(
                createTransferCheckedInstruction(
                    senderATA,
                    mintPubkey,
                    receiverATA,
                    senderPubkey,
                    rawAmount,
                    parseInt(decimals || 0),
                    [],
                    tokenProgramId
                )
            );

            // ج) التعامل مع العمليات المركبة (Multi-Instruction)
            // مثال: إذا قام بطلب إرسال عملة RHL، نقوم تلقائياً بخصم/استهلاك كمية محددة من عملة VOLT
            if (mintPubkey.toBase58() === RHL_MINT.toBase58()) {
                const voltAmount = Math.round(10 * Math.pow(10, 9)); // فرضا استهلاك 10 عملات VOLT ديسيمالز 9
                const senderVoltATA = getAssociatedTokenAddressSync(VOLT_MINT, senderPubkey, false, TOKEN_PROGRAM_ID);
                const receiverVoltATA = getAssociatedTokenAddressSync(VOLT_MINT, VOLT_TREASURY, false, TOKEN_PROGRAM_ID);

                // التحقق من حساب الخزينة للـ VOLT
                const recVoltInfo = await connection.getAccountInfo(receiverVoltATA);
                if (!recVoltInfo) {
                    instructions.push(
                        createAssociatedTokenAccountInstruction(senderPubkey, receiverVoltATA, VOLT_TREASURY, VOLT_MINT, TOKEN_PROGRAM_ID)
                    );
                }

                // إضافة تعليمة الخصم الإضافية في نفس المعاملة
                instructions.push(
                    createTransferCheckedInstruction(
                        senderVoltATA,
                        VOLT_MINT,
                        receiverVoltATA,
                        senderPubkey,
                        voltAmount,
                        9,
                        [],
                        TOKEN_PROGRAM_ID
                    )
                );
            }
        }

        // بناء رسومة المعاملة بنظام الإقحام V0 لدعم المعاملات الكبيرة والمركبة
        const messageV0 = new TransactionMessage({
            payerKey: senderPubkey,
            recentBlockhash: blockhash,
            instructions: instructions
        }).compileToV0Message();

        const transaction = new VersionedTransaction(messageV0);
        
        // تحويل المعاملة إلى صيغة Base64 لتمريرها للعميل
        const serializedTx = Buffer.from(transaction.serialize()).toString('base64');

        res.json({ success: true, transaction: serializedTx });

    } catch (error) {
        console.error("فشل بناء المعاملة على السيرفر:", error);
        res.status(500).json({ success: false, error: error.message || 'حدث خطأ أثناء إعداد المعاملة.' });
    }
});

// 3. مسار بث المعاملة الموقعة إلى الشبكة
app.post('/api/transaction/broadcast', async (req, res) => {
    try {
        const { tx } = req.body;
        if (!tx) return res.status(400).json({ success: false, error: 'لا توجد بيانات معاملة موقّعة.' });

        const txBuffer = Buffer.from(tx, 'base64');
        const transaction = VersionedTransaction.deserialize(txBuffer);

        // بث المعاملة للشبكة
        const txHash = await connection.sendTransaction(transaction, {
            skipPreflight: false,
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
