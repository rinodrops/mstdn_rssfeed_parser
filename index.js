// mstdn_rssfeed_parser
// Parse RSS Feed of Mastodon to retrieve information of the newly created post
// for AWS Lambda + DynamoDB

// import dependencies
import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import axios from 'axios';
import xml2js from 'xml2js';

// read .env file and set constants
import dotenv from 'dotenv';
dotenv.config();
const IFTTT_EVENT_NAME = process.env.IFTTT_EVENT_NAME;
const IFTTT_KEY = process.env.IFTTT_KEY;
const TABLE_NAME = process.env.TABLE_NAME;
const RSS_FEED_URL = process.env.RSS_FEED_URL;
const DYNAMODB_REGION = process.env.DYNAMODB_REGION;
const MAX_ITEMS = parseInt(process.env.MAX_ITEMS, 10);
const LOG_LEVEL = process.env.LOG_LEVEL;

const webhookUrl = `https://maker.ifttt.com/trigger/${IFTTT_EVENT_NAME}/json/with/key/${IFTTT_KEY}`;
if (LOG_LEVEL === 'debug') console.log('webhookUrl:', webhookUrl);

// instantiate the DynamoDB client
const ddb = new DynamoDBClient({ region: DYNAMODB_REGION });

export const handler = async (event) => {
    // read RSS Feed
    const rssFeedResponse = await axios.get(RSS_FEED_URL);
    if (LOG_LEVEL === 'debug') console.log('RSS feed response:', rssFeedResponse.data);

    // get the last processed item's publish time
    const lastProcessedItem = await ddb.send(new GetItemCommand({
        TableName: TABLE_NAME,
        Key: { id: { S: 'last_processed_item' } },
    }));
    let lastProcessedPubDate = lastProcessedItem.Item ? parseInt(lastProcessedItem.Item.pubDate.N) : null;
    let newProcessedPubDate = lastProcessedPubDate;
    if (LOG_LEVEL === 'debug') console.log('Last processed item:', lastProcessedItem.Item);

    // instantiate the XML parser
    const parser = new xml2js.Parser();
    try {
        // <rss>
        //   <channel>
        //     <item>                // each post
        //       <guid>
        //       <link>              // parmalink
        //       <pubDate>           // published time
        //       <description>       // content of the post
        //       <media:content url> // media url
        const result = await parser.parseStringPromise(rssFeedResponse.data);

        // get items as array
        const items = result.rss.channel[0].item;
        if (LOG_LEVEL === 'debug') console.log('Parsed items:', items);

        // limit to MAX_ITEMS
        // this code assumes that the items in the RSS Feed array are
        // ordered from newest to oldest.
        const latestItems = items.slice(0, MAX_ITEMS);
        if (LOG_LEVEL === 'debug') console.log('Latest items:', latestItems);

        // calling IFTTT webhook could take time, so it is necessary
        // to wait until all the requests are processed
        // to track for each item, create promises to store them
        const postPromises = latestItems.map(async item => {
            // get pubDate and convert it to the number in milliseconds
            // since the Unix epoch (January 1, 1970)
            const pubDate = new Date(item.pubDate[0]).getTime();
            if (LOG_LEVEL === 'debug') console.log('pubDate:', pubDate);

            // process only items newer than the last processed one
            if (!lastProcessedPubDate || lastProcessedPubDate < pubDate) {
                // extract permalink, pubDate and the content
                // they should exist in every post
                const permalink = item.link[0];
                const published = item.pubDate[0];
                const content = item.description[0];
                const postData = { permalink, published, content };

                // if media is attached...
                if (item['media:content']) {
                    // get the url of the first media file
                    postData.media = item['media:content'][0].$.url;
                }
                // otherwise...
                else {
                    // set media url as no image placeholder
                    postData.media = 'no_image_card.png';
                }
                if (LOG_LEVEL === 'debug') console.log('postData:', postData);

                // update the last processed item's date
                if (!newProcessedPubDate || newProcessedPubDate < pubDate) newProcessedPubDate = pubDate;
                if (LOG_LEVEL === 'debug') console.log('Renewed pubDate:', newProcessedPubDate);

                // make an IFTTT webhook request in sync
                const response = await axios.post(webhookUrl, postData);
                return response;
            }
            else {
                return Promise.resolve();
            }
        });

        if (LOG_LEVEL === 'debug') console.log('Post promises:', postPromises);

        // store the last processed item's date
        return Promise.allSettled(postPromises)
            .then(() => {
                if (LOG_LEVEL === 'debug') console.log('Post promises:', postPromises);
                if (LOG_LEVEL === 'debug') console.log('All promises have resolved');
                return ddb.send(new PutItemCommand({
                        TableName: TABLE_NAME,
                        Item: {
                            id: { S: 'last_processed_item' },
                            pubDate: { N: newProcessedPubDate.toString() },
                        },
                    }));
            })
            .catch(error => {
                if (LOG_LEVEL === 'debug') console.log('Post promises:', postPromises);
                if (LOG_LEVEL === 'debug') console.log('Error in Promise.all():', error);
            });
    }
    catch (error) {
        console.log("An error occurred:", error);
    }
};
